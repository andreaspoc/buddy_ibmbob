"""Run queued Buddy requests outside the web request lifecycle."""
from __future__ import annotations

from app.branding import brand_name, brand_text
import asyncio
import json
import logging
import os
import uuid
from contextlib import aclosing
from pathlib import Path
from urllib.parse import urlparse

from app.acp_bridge import BobACPBridge, _task_exists
from app.a2a_client import stream_message as stream_a2a_message
from app import job_queue, postgres_storage as storage, rag
from app.sessions import append_history, user_root, workspace_for, read_history, storage_scope
from app.workspace_config import get_agent, select_root, list_skills, resolve_skill_name
from app.skill_routing import add_skill_routing
from app.streaming import coalesce_text
from app.guided_chat import stream_guided_chat
from app.chat_guidance import supported as guidance_supported
from app.knowledge_intent import knowledge_policy
from app.research_engine import is_research_workspace, stream_research
from app.team_runs import stream_workflow
from app.conversation_context import add_conversation_context
from app.chat_response_policy import response_policies, interactive_response_policy
from app.intelligent_ui import INTELLIGENT_UI_POLICY
from app.html_artifact_check import flag_changed_html, html_versions
from app.html_artifact_policy import create_html_scaffold, html_artifact_instruction
from app.clarification import add_clarification_policy, clarification_questions
from app.sticky_notes import add_sticky_notes_policy


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
bridge = BobACPBridge()


def _complete_html_deck(path: Path) -> bool:
    if not path.is_file():
        return False
    source = path.read_text(encoding="utf-8", errors="replace").lower()
    from app.presentation import artifact_role
    return "<body" in source and "</body>" in source and "</html>" in source and artifact_role(str(path), source)["is_presentation"]


def _restore_incomplete_html(path: Path, original: bytes | None) -> bool:
    """Keep a failed rewrite from replacing the last complete presentation."""
    if not path.is_file() or _complete_html_deck(path):
        return False
    if original is not None:
        path.write_bytes(original)
    else:
        path.rename(path.with_name(".presentation.incomplete.html"))
    return True


async def _heartbeat(job_id: str, token: str, work_task: asyncio.Task) -> None:
    while True:
        await asyncio.sleep(20)
        try:
            alive = await asyncio.to_thread(job_queue.heartbeat, job_id, token)
        except Exception:
            logger.exception("Heartbeat failed for job %s", job_id)
            continue
        if not alive:
            logger.error(brand_text("Job %s lost its lease; cancelling Buddy"), job_id)
            work_task.cancel()
            return


async def _watch_cancel(job_id: str, work_task: asyncio.Task) -> None:
    while not work_task.done():
        try:
            if await asyncio.to_thread(job_queue.cancellation_requested, job_id):
                work_task.cancel()
                return
        except Exception:
            logger.exception("Cancellation check failed for job %s; retrying", job_id)
        await asyncio.sleep(0.3)


async def _record(job: dict, event: dict, *, terminal: bool = False) -> bool:
    job_id, token = str(job["id"]), str(job["worker_token"])
    return await asyncio.to_thread(job_queue.finish if terminal else job_queue.append_event, job_id, token, event)


async def _run(job: dict) -> None:
    username, session_id = job['username'], job['workspace_id']
    from app.app_actions import action_context
    from app.agent_budget import RunBudget
    from app.execution_policy import ExecutionAuthorizer
    context = {'username':username,'workspace_id':session_id,'assistant_message_id':job['payload'].get('assistant_message_id'),
               'timezone':job['payload'].get('client_timezone') or os.getenv('DEFAULT_TIMEZONE','UTC'),
               'agent_slugs': tuple(job['payload'].get('agent_slugs', ())),
               'job': job,
               'agent_budget': RunBudget(username)}
    async def emit_approval(event):
        if not context.get('emit'):
            raise PermissionError('Approval channel is unavailable')
        await context['emit'](event)
    context['execution_authorizer'] = ExecutionAuthorizer(username=username, job_id=job['id'],
        worker_token=job['worker_token'], emit=emit_approval)
    with storage.job_workspace(username, session_id) as (root, workspace):
        context["workspace"] = str(workspace)
        context_token = action_context.set(context)
        try:
            await _run_in_workspace(job, root, workspace)
        except BaseException:
            await bridge.release_prepared(job['id'])
            # Cancelled/failed runs can still contain useful generated files.
            await asyncio.to_thread(storage.persist_job, job, root, workspace)
            raise
        finally:
            await bridge.release_prepared(job['id'])
            action_context.reset(context_token)


async def _run_in_workspace(job: dict, root: Path, workspace: Path) -> None:
    username, session_id = job['username'], job['workspace_id']
    payload = job['payload']
    from app.carbon_chart_assets import carbon_html_versions, package_changed_carbon_html
    carbon_before = await asyncio.to_thread(carbon_html_versions, workspace)
    html_before = await asyncio.to_thread(html_versions, workspace)
    html_artifact_path = payload.get('html_artifact_output_path')
    if html_artifact_path:
        storage.validate_path(html_artifact_path)
        scaffold = workspace / html_artifact_path
        if scaffold.exists():
            raise RuntimeError('Dashboard output already exists; refusing to replace an existing file')
        scaffold.write_text(create_html_scaffold(), encoding='utf-8')
    from app.response_language import assistant_name_instruction, language_instruction
    response_language = language_instruction(payload.get('ui_language', 'en'))
    select_root(root)
    from app.agent_attachments import selected_agents, add_agent_routing
    attached_agents = await asyncio.to_thread(selected_agents, username, payload.get('agent_slugs', []))
    if payload.get('approval_policy', {}).get('mode') == 'selected' and payload.get('agent_name'):
        raise RuntimeError('Remote agents cannot enforce selected approvals')
    async with job_queue.JobStreamRecorder(job["id"], job["worker_token"], username, session_id, durable=True, correlation=payload) as recorder:
        from app.app_actions import action_context
        if action_context.get() is not None:
            action_context.get()['emit'] = recorder.record_event
        from app.toolbar_reminders import handle_direct_request
        if await handle_direct_request(job, recorder, action_context.get() or {}):
            return
        if html_artifact_path:
            from app.live_artifacts import snapshots
            initial = await asyncio.to_thread(snapshots, workspace, [html_artifact_path])
            if html_artifact_path in initial:
                await recorder.record_event(initial[html_artifact_path])
        if payload.get("agent_name"):
            await action_context.get()['agent_budget'].consume('inference')
            await action_context.get()['agent_budget'].consume('remote')
            await recorder.record_event({"type": "start"})
            agent = get_agent(payload["agent_name"])
            if not agent or agent.get('disabled') or agent.get('enabled') is False:
                raise RuntimeError("A2A agent is no longer configured")
            registered_agent = dict(agent)
            endpoint = urlparse(agent["endpoint"])
            local = (
                endpoint.hostname in {"localhost", "127.0.0.1", "host.docker.internal"}
                and (endpoint.port in {3000, 8080} or endpoint.port is None)
                and endpoint.path.rstrip("/") == "/a2a"
            )
            if local:
                agent = {**agent, "endpoint": os.getenv("BOB_INTERNAL_A2A_URL", "http://bob-agent:8080/a2a")}
            await recorder.record_event({"type": "status", "message": f"Waiting for {agent['name']}…"})
            streamed = False
            result = {"text": "", "context_id": payload.get("agent_context_id")}
            remote_prompt = payload['prompt'] + response_language
            if payload.get('context_rebuilt'):
                remaining_history = await asyncio.to_thread(read_history, session_id, username)
                remote_prompt = add_conversation_context(remote_prompt, remaining_history, [], workspace=workspace, include_history=True)
            try:
                authorizer = action_context.get()['execution_authorizer']
                await authorizer.authorize({'action': 'a2a_ask', 'slug': payload['agent_name'],
                    'prompt': remote_prompt, 'context_id': payload.get('agent_context_id')}, agent)
                if await asyncio.to_thread(get_agent, payload['agent_name']) != registered_agent:
                    raise PermissionError('A2A agent configuration changed during approval')
                await authorizer.assert_active()
                async with aclosing(stream_a2a_message(agent, remote_prompt, payload.get("agent_context_id"))) as source:
                    async for event in source:
                        if event["type"] == "a2a_result":
                            result = event
                            if not streamed:
                                await recorder.record_event({"type": "delta", "text": result["text"]})
                        else:
                            if event["type"] == "delta": streamed = True
                            await recorder.record_event(event)
                done = {"type": "done", "agent_context_id": result.get("context_id")}
            except Exception as exc:
                logger.exception("A2A agent %s failed", payload.get("agent_name"))
                done = {"type": "error", "message": f"A2A agent '{agent.get('name', payload.get('agent_name'))}' error: {exc}"}
        else:
            done = None
            bob_prompt = payload["bob_prompt"]
            from app.personalization import personalize_prompt
            bob_prompt = await asyncio.to_thread(personalize_prompt, bob_prompt, username)
            from app.workspace_config import ensure_brave_mcp
            await asyncio.to_thread(ensure_brave_mcp)
            if os.getenv('BOB_AGENT_PREWARM', '1') != '0':
                bridge.prewarm_approval(job, workspace=str(workspace),
                                        user_home=str(root / '.home'), mode=payload['mode'])

            if (payload.get('workflow') or {}).get('web_search') or (payload.get('research') or {}).get('web_search'):
                from app.mcp_access import get_authorized_server
                brave = await asyncio.to_thread(get_authorized_server, username, 'brave_search')
                if not brave or brave.get('disabled'):
                    await recorder.finish({'type': 'error', 'message': 'Web search is not available for your employee groups'})
                    return
                if not os.getenv('BRAVE_API_KEY', '').strip():
                    await recorder.finish({'type': 'error', 'message': 'Web search requires BRAVE_API_KEY'})
                    return
            if payload.get("workflow"):
                from app.hooks import execute_event_hooks
                allowed, context, error = await execute_event_hooks(
                    "UserPromptSubmit", {"prompt": payload["prompt"], "workspace_id": session_id, "user": username},
                    match_target=payload["prompt"],
                )
                if not allowed:
                    await recorder.finish({"type": "error", "message": "Workflow blocked by policy hook: " + (error or "Forbidden prompt")})
                    return
                if context:
                    bob_prompt += "\n\n[Context from lifecycle hook]:\n" + context
            db_file = root / ".home" / ".bob" / "db" / "bob.db"
            if not db_file.is_file():
                db_file = Path("/root/.bob/db/bob.db")
            native_task_available = bool(payload.get('session_id')) and _task_exists(db_file, payload.get("session_id"))
            # Independent, owner-scoped reads run after policy hooks. Agent tool
            # execution and approval decisions retain their original ordering.
            from app.project_memory import context_for_session
            from app import conversation_documents
            scope = storage_scope(session_id, username)
            files, history, project_context, document_context = await asyncio.gather(
                asyncio.to_thread(storage.list_files, username, scope),
                asyncio.to_thread(read_history, session_id, username),
                asyncio.to_thread(context_for_session, username, session_id),
                asyncio.to_thread(conversation_documents.context_manifest, username, scope),
            )
            is_research_report_ws = is_research_workspace(workspace, files)
            voice_mode = bool(payload.get('voice_mode'))
            user_prompt_text = payload.get('prompt', '')
            user_prompt_lower = user_prompt_text.lower()
            if not voice_mode:
                bob_prompt += ('\n\nFor CSV or spreadsheet analysis, perform the full requested analysis and deliver findings, '
                               'supporting calculations, data quality observations and limitations in chat. '
                               'Inspect column headers and only a small sample to understand the schema. Based on the user request and actual columns, '
                               'write a script that processes the source directly, computing the needed results without sending all rows to the model. '
                               'Stream large files in chunks when practical; do not repeatedly read blocks of rows into the model. '
                               'Decide each next analysis or tool action from the question, schema and results obtained so far; '
                               'investigate relevant anomalies or missing context as needed instead of following a fixed checklist. '
                               'Check relevant types, missing or invalid values, duplicates and units; report material limitations and distinguish the full dataset from any sample. '
                               'Compute findings from the data, not guesses; never infer category names, currency, meaning or external lookup mappings without evidence. '
                               'Do not create an HTML dashboard unless the user explicitly requests one. '
                               'When a dashboard is requested, use only interactive Chart.js charts and retain the existing Carbon UI.')
                if not is_research_report_ws:
                    bob_prompt += html_artifact_instruction(payload.get('prompt', ''), html_artifact_path)
                else:
                    bob_prompt += (
                        "\n\n[RESEARCH REPORT WORKSPACE DIRECTIVE - FOLLOW-UP FIXES & UPDATES]:\n"
                        "This workspace belongs to an executive research report saved at `research-report.md`. The Research tab shows only that file. If it does not exist yet, write the complete report there, using the conversation history and saved research files.\n"
                        "When the user asks follow-up questions, requests fixes, or asks to adjust/fix charts, numbers, comparisons, or findings:\n"
                        "1. EDIT IN PLACE: Directly update `research-report.md` in the workspace using file editing tools so the report reflects the changes immediately. DO NOT create separate HTML files, dashboards, or extra artifact pages.\n"
                        "2. VISIBLE CARBON CHARTS: If the user notes that a chart was not visible or asks to fix/add a chart, embed Carbon data charts directly in `research-report.md` using fenced ```chart or ```bobchart JSON blocks:\n"
                        "```chart\n"
                        "{\n"
                        '  "type": "bar" | "line" | "pie" | "doughnut",\n'
                        '  "title": "Clear Title with Units",\n'
                        '  "labels": ["Item A", "Item B"],\n'
                        '  "datasets": [{"label": "Series Name", "data": [10, 25]}]\n'
                        "}\n"
                        "```\n"
                        "Ensure the JSON is strictly valid so the Research Report viewer renders the chart visually.\n"
                        "3. PRESERVE CITATIONS: Preserve existing [S1] inline citations and the bibliography section.\n"
                        "4. USER RESPONSE: Tell the user concisely what was updated in `research-report.md` and that the updated report is open in the Research tab.\n"
                    )
                is_quiz_intent = (
                    bool(payload.get('quiz_grading_context'))
                    or any(w in user_prompt_lower for w in ('quiz', 'test', 'exam', 'assessment', 'multiple choice', 'multiple-choice', 'questionnaire', 'bobquiz'))
                    or any('quiz' in s.lower() or 'knowledge' in s.lower() for s in payload.get('skill_names', []))
                )
                if is_quiz_intent:
                    from app.quiz import QUIZ_POLICY
                    bob_prompt += QUIZ_POLICY
            bob_prompt = add_conversation_context(bob_prompt, history, files, workspace=workspace,
                                                  include_history=True)
            bob_prompt += project_context
            if document_context:
                bob_prompt += "\n\n" + document_context
            bob_prompt += f"\nThe saved files are restored in the current workspace: {workspace}. Use this workspace; temporary paths from previous runs no longer exist."
            from datetime import datetime, timezone
            now_dt = datetime.now(timezone.utc)
            date_banner = f"\n\n[Current Temporal Context: Today is {now_dt.strftime('%A, %B %d, %Y')}. The current year is {now_dt.year}. When researching recent events, sports scores, news, or latest versions, always use {now_dt.year} (or omit the year). Never assume or hardcode past years like {now_dt.year - 1} or earlier for latest information.]"
            from app.branding import identity_instruction
            identity = identity_instruction()
            if voice_mode:
                from app.voice_policy import discussion_persona
                identity = discussion_persona(identity)
            diagram_policy, chat_response_policy = response_policies(payload, history, files)
            bob_prompt = f"{identity}\n\n" + f"{knowledge_policy(bob_prompt)}{date_banner}\n\n{diagram_policy}"
            documents = []
            available_skills = list_skills(restored=True)
            selected_skills = list(dict.fromkeys(([payload['skill_name']] if payload.get('skill_name') else []) + payload.get('skill_names', [])))
            if len(selected_skills) > 6:
                raise RuntimeError('Select up to 6 skills.')
            resolved_skills = []
            for previous_name in selected_skills:
                name = resolve_skill_name(previous_name)
                if not any(skill['name'] == name for skill in available_skills):
                    raise RuntimeError('A selected skill was deleted or is no longer available. Select another skill and retry.')
                bob_prompt = bob_prompt.replace(f'${previous_name} ', f'${name} ')
                if name not in resolved_skills:
                    resolved_skills.append(name)
            payload['skill_names'] = resolved_skills
            payload['skill_name'] = resolved_skills[0] if resolved_skills else None
            if not payload.get('edit_artifact_path'):
                bob_prompt = add_skill_routing(bob_prompt, available_skills, explicit_skill=payload.get("skill_name"), explicit_skills=resolved_skills,
                                               mode=payload["mode"], documents=[d["filename"] for d in documents], template_id=payload.get("template_id"),
                                               request_prompt=payload["prompt"], voice_mode=voice_mode)
            clarification_supported = not (payload.get("research") or payload.get("workflow"))
            is_notes_intent = (
                bool(payload.get('note_references'))
                or any(w in user_prompt_lower for w in ('note', 'notes', 'sticky', 'pin', 'remind', 'memo', 'bobnotes'))
                or any('note' in s.lower() for s in payload.get('skill_names', []))
            )
            if not voice_mode:
                bob_prompt = add_clarification_policy(bob_prompt, supported=clarification_supported)
                if is_notes_intent:
                    bob_prompt = add_sticky_notes_policy(bob_prompt)
            if not voice_mode and clarification_supported and payload["mode"] != "presentation" and not payload.get("edit_artifact_path") and not is_research_report_ws:
                bob_prompt += INTELLIGENT_UI_POLICY
            if payload.get('quiz_grading_context'):
                bob_prompt += payload['quiz_grading_context']
            if chat_response_policy:
                bob_prompt += '\n\n' + chat_response_policy
            response_text = ""
            html_path = workspace / (payload.get('edit_artifact_path') or payload.get('presentation_output_path') or 'presentation.html')
            original_html = html_path.read_bytes() if html_path.is_file() and html_path.suffix.lower() in {'.html', '.htm'} else None
            from app.presentation import artifact_role
            guard_presentation = (payload.get("mode") == "presentation" and payload.get("presentation_format") == "html") or bool(
                payload.get('edit_artifact_path') and original_html and artifact_role(str(html_path), original_html)['is_presentation']
            )
            from app.mcp_access import allowed_servers, catalog
            from app.redaction import config_secrets
            configs = await asyncio.to_thread(allowed_servers, username)
            recorder.activity_secrets.extend(secret for config in configs.values() for secret in config_secrets(config))
            connections = await asyncio.to_thread(catalog, username)
            active_mcp = [c['name'] for c in connections if not c.get('disabled')]
            if active_mcp:
                bob_prompt += (
                    f"\n\nConfigured MCP connections: {', '.join(active_mcp)}. "
                    "External MCP connections load on demand. Discover tool schemas with `python3 -m app.mcp_client tools SERVER`, then call `python3 -m app.mcp_client call SERVER TOOL --arguments JSON` in workspace. Built-in app tools are available natively."
                )
            is_app_tools_intent = (
                is_notes_intent
                or bool(payload.get('office_references'))
                or any(w in user_prompt_lower for w in ('office', 'docx', 'xlsx', 'pptx', 'reminder', 'remind', 'specialist', 'delegate'))
                or any(s in ('office-insights', 'presentation-buddy') for s in payload.get('skill_names', []))
            )
            if is_app_tools_intent:
                from app.app_actions import APP_TOOLS_POLICY
                bob_prompt += '\n\n' + brand_text(APP_TOOLS_POLICY)
            timing_policy = interactive_response_policy(payload)
            if timing_policy:
                bob_prompt += '\n\n' + timing_policy
            bob_prompt += response_language + assistant_name_instruction(payload.get('assistant_name'))
            bob_prompt = add_agent_routing(bob_prompt, attached_agents, ui_language=payload.get('ui_language', 'en'))
            try:
                source = (bridge.stream_with_approvals(bob_prompt, job, workspace=str(workspace),
                            user_home=str(root / '.home'), mode=payload['mode'])
                          if not payload.get('agent_name') and not payload.get('research') and not payload.get('workflow') else
                          stream_research(bridge, bob_prompt, payload["research"], workspace=str(workspace), user_home=str(root / ".home"), mode=payload["mode"], username=username) if payload.get("research") else stream_workflow(bridge, bob_prompt, payload["workflow"],
                            workspace=str(workspace), user_home=str(root / ".home"), mode=payload["mode"], username=username)
                          if payload.get("workflow") else stream_guided_chat(
                            bridge, bob_prompt, job, workspace=workspace, user_home=root / ".home", mode=payload["mode"])
                          if guidance_supported(payload) else bridge.stream(
                            bob_prompt, payload.get("session_id"), payload["mode"],
                            workspace=str(workspace), user_home=str(root / ".home"), username=username))
                from app.live_artifacts import stream_live_artifacts
                source = stream_live_artifacts(source, workspace, initial_paths=[html_artifact_path] if html_artifact_path else None)
                completion_started = None
                async with aclosing(source) as stream:
                    async for event in coalesce_text(stream, interval=0.008):
                        if event.get("type") in {"done", "error"}:
                            completion_started = asyncio.get_running_loop().time()
                            done = event
                            break
                        if event.get("type") == "delta":
                            response_text = event.get("text", "") if event.get("replace") else response_text + event.get("text", "")
                        if not await recorder.record_event(event):
                            return
            except TimeoutError:
                done = {"type": "error", "message": "Workflow time limit reached"}
            finally:
                if guard_presentation and _restore_incomplete_html(html_path, original_html):
                    logger.warning("Restored incomplete HTML deck for job %s", job["id"])
                    if not (clarification_supported and clarification_questions(response_text)) or (done and done.get("type") == "error"):
                        done = {"type": "error", "message": f"{brand_name()} left {html_path.name} incomplete; the previous complete deck was restored."}
            if done is None:
                done = {"type": "error", "message": brand_text("Buddy stopped without a result")}
            if completion_started is not None:
                logger.info('Job %s agent cleanup took %.3fs', job['id'], asyncio.get_running_loop().time() - completion_started)

        if payload.get('quiz_grading_context') and done.get('type') == 'done':
            from app.quiz_review import finalize_review
            await recorder.record_event({'type':'status','message':'Reviewing missed concepts and finding useful reading…'})
            try:
                review = await finalize_review(response_text, payload['quiz_grading_context'], username)
                await recorder.record_event({'type':'delta','text':review,'replace':True})
            except ValueError as exc:
                await recorder.record_event({'type':'delta','text':str(exc),'replace':True})
                done = {'type':'error','message':str(exc)}
        # Text generation is finished. Publish this before file I/O so clients
        # can finalize the answer while persistence continues on a worker thread.
        # The job and its workspace remain owned until files are durably saved.
        if done.get('type') == 'done':
            from app.delivery import delivery_event
            if not await recorder.record_event(delivery_event('saving', recorder.correlation)):
                return
        # Package only changed, complete dashboards that opted into Buddy Carbon assets.
        save_started = asyncio.get_running_loop().time()
        await asyncio.to_thread(package_changed_carbon_html, workspace, carbon_before)
        await asyncio.to_thread(flag_changed_html, workspace, html_before)
        # Save files before publishing completion so downloads are immediately ready.
        await asyncio.to_thread(storage.persist_job, job, root, workspace)
        logger.info('Job %s artifact packaging and persistence took %.3fs', job['id'], asyncio.get_running_loop().time() - save_started)
        await recorder.finish(done)


async def execute_job(job: dict, token: str) -> None:
    work_task = asyncio.create_task(_run(job))
    heartbeat = asyncio.create_task(_heartbeat(str(job["id"]), token, work_task))
    cancel_watch = asyncio.create_task(_watch_cancel(str(job["id"]), work_task))
    try:
        await work_task
    except asyncio.CancelledError:
        if await asyncio.to_thread(job_queue.cancellation_requested, str(job["id"])):
            await _record(job, {"type": "error", "message": "Stopped by you", "cancelled": True}, terminal=True)
        else:
            raise
    except Exception:
        logger.exception("Job %s failed", job["id"])
        await _record(job, {"type": "error", "message": brand_text("Buddy job failed; check worker logs")}, terminal=True)
    finally:
        cancel_watch.cancel()
        heartbeat.cancel()
        # Drain both children without swallowing cancellation of execute_job.
        await asyncio.gather(cancel_watch, heartbeat, return_exceptions=True)


async def _work_loop() -> None:
    await asyncio.to_thread(job_queue.ensure_schema)
    token = str(uuid.uuid4())
    logger.info(brand_text("Buddy worker %s ready"), token)
    while True:
        try:
            # Listen before checking the queue so jobs arriving between the
            # check and the wait cannot be missed. Poll as a recovery fallback.
            async with await job_queue.worker_listener() as listener:
                while True:
                    await asyncio.to_thread(job_queue.requeue_expired)
                    job = await asyncio.to_thread(job_queue.claim, token)
                    if job is None:
                        async with aclosing(listener.notifies(timeout=1, stop_after=1)) as notifications:
                            async for _ in notifications:
                                break
                        continue
                    logger.info("Claimed job %s attempt %s", job["id"], job["attempts"] + 1)
                    await execute_job(job, token)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Worker loop failed")
            await asyncio.sleep(3)


async def _blob_cleanup_loop() -> None:
    from app import blob_storage, postgres_storage, rag
    await asyncio.to_thread(postgres_storage.ensure_schema)
    await asyncio.to_thread(rag.ensure_schema)
    while True:
        try:
            await asyncio.to_thread(blob_storage.collect_garbage)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Deferred blob cleanup failed; will retry")
        await asyncio.sleep(300)


async def main() -> None:
    from app.workflows import scheduler_loop
    async with asyncio.TaskGroup() as group:
        group.create_task(_work_loop())
        from app.plugin_client import enabled
        if enabled("people") and not os.getenv("BUDDY_PEOPLE_PLUGIN_URL", "").strip():
            from app.community_away import worker_loop as away_worker_loop
            group.create_task(away_worker_loop())
        group.create_task(scheduler_loop())
        group.create_task(_blob_cleanup_loop())


if __name__ == "__main__":
    asyncio.run(main())
