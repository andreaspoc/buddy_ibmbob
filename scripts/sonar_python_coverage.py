"""Generate measured Python coverage for the next SonarQube scan."""
from importlib.util import find_spec
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / 'reports' / 'sonar-python' / 'coverage.xml'
DEFAULT_TESTS = (
    'tests.test_admin_email_parser',
    'tests.test_decision_text_boundaries',
    'tests.test_text_parser_boundaries',
    'tests.test_gateway_shutdown',
    'tests.test_job_stream_routes_isolated',
    'tests.test_mcp_stdio_cleanup',
    'tests.test_jsonb_sanitization',
    'tests.test_regex_boundaries',
    'tests.test_branding',
    'tests.test_browser_security',
    'tests.test_backend_access_index',
    'tests.test_mcp_redaction',
    'tests.test_mcp_client_limits',
    'tests.test_mcp_discovery_limits',
    'tests.test_private_directories',
    'tests.test_sonar_regressions',
    'tests.test_clarification',
    'tests.test_gate_decisions_api',
    'tests.test_gate_decisions_governance',
    'tests.test_gate_decisions_flow',
    'tests.test_gate_office_assistant',
    'tests.test_gate_learning_service',
    'tests.test_gate_main_routes',
    'tests.test_decisions_correctness',
    'tests.test_decisions_fail_closed',
    'tests.test_flow_designer_prompts',
    'tests.test_decisions_access',
    'tests.test_decisions_execution',
    'tests.test_decisions_fact_inference',
    'tests.test_decisions_simulation_kpis',
    'tests.test_decisions_vocabulary',
    'tests.test_decisions_cp4d',
    'tests.test_safe_http',
    'tests.test_a2a_streaming',
    'tests.test_a2a_stream_lifecycle_unit',
    'tests.test_a2a_discovery_unit',
    'tests.test_a2a_cli',
    'tests.test_a2a_task_notifications',
    'tests.test_html_artifact_policy',
    'tests.test_dashboard_standard',
    'tests.test_html_artifact_check',
    'tests.test_learning_translation_batches',
    'tests.test_learning_translation_check',
    'tests.test_quiz',
    'tests.test_presentation_templates',
    'tests.test_presentation_routing',
    'tests.test_response_language',
    'tests.test_skill_routing',
    'tests.test_agent_budget',
    'tests.test_conversation_context',
    'tests.test_sticky_notes_policy',
    'tests.test_learning_access',
    'tests.test_learning_lesson_api',
    'tests.test_learning_lessons',
    'tests.test_learning_documents',
    'tests.test_learning_document_limits_extra',
    'tests.test_learning_epub',
    'tests.test_learning_declaration_limits',
    'tests.test_learning_classrooms',
    'tests.test_learning_enrollment_email',
    'tests.test_learning_new_module',
    'tests.test_learning_document_draft',
    'tests.test_learning_model_json',
    'tests.test_app_registry',
    'tests.test_learning_course_completion',
    'tests.test_learning_deletion',
    'tests.test_learning_generation_quota',
    'tests.test_learning_groups',
    'tests.test_learning_hierarchy',
    'tests.test_learning_office_import',
    'tests.test_learning_quizzes',
    'tests.test_learning_results',
    'tests.test_productivity',
    'tests.test_office_app_actions',
    'tests.test_office_ai_stream_extra',
    'tests.test_office_action_boundaries_extra',
    'tests.test_office_forms',
    'tests.test_office_native_tools',
    'tests.test_user_personalization',
    'tests.test_main_http_api',
    'tests.test_main_routes_validation',
    'tests.test_agent_warmup',
    'tests.test_access_boundary',
    'tests.test_access_views',
    'tests.test_acp_error_diagnostics',
    'tests.test_admin_users',
    'tests.test_agent_attachments',
    'tests.test_agent_catalog',
    'tests.test_agent_completion_latency',
    'tests.test_agent_phase_security',
    'tests.test_agent_sandbox',
    'tests.test_answer_feedback',
    'tests.test_app_agents',
    'tests.test_artifact_comments',
    'tests.test_artifact_provenance',
    'tests.test_artifact_revision_source',
    'tests.test_auth_boundary',
    'tests.test_blob_storage_verification',
    'tests.test_business_connectors',
    'tests.test_chat_correlation',
    'tests.test_chat_response_policy',
    'tests.test_chat_submission',
    'tests.test_chat_stream_paths',
    'tests.test_community_away',
    'tests.test_community_bob',
    'tests.test_community_collaboration',
    'tests.test_community_typing',
    'tests.test_conversation_branching',
    'tests.test_conversation_documents',
    'tests.test_conversation_sharing',
    'tests.test_conversation_titles',
    'tests.test_decisions_api_security',
    'tests.test_decisions_migration',
    'tests.test_decisions_modern_integration',
    'tests.test_decisions_parallel',
    'tests.test_decisions_persistence',
    'tests.test_decisions_release_security',
    'tests.test_decisions_workbook',
    'tests.test_delivery',
    'tests.test_deploy_buddy',
    'tests.test_deploy_frontend_assets',
    'tests.test_diagram_policy',
    'tests.test_document_comparison',
    'tests.test_execution_boundary',
    'tests.test_feature_schemas',
    'tests.test_file_delivery',
    'tests.test_flow_designer_topologies',
    'tests.test_frontend_assets',
    'tests.test_gateway',
    'tests.test_guided_chat',
    'tests.test_hook_routes_security',
    'tests.test_hook_security',
    'tests.test_interactive_widgets',
    'tests.test_job_queue_lifecycle',
    'tests.test_keycloak_auth',
    'tests.test_knowledge_freshness',
    'tests.test_knowledge_cli',
    'tests.test_knowledge_quota',
    'tests.test_live_artifacts',
    'tests.test_login_throttle',
    'tests.test_mcp_access',
    'tests.test_mcp_catalog',
    'tests.test_mcp_config',
    'tests.test_mcp_enable',
    'tests.test_mcp_health',
    'tests.test_mcp_keycloak',
    'tests.test_mcp_metadata_redaction',
    'tests.test_mcp_microsoft_unit',
    'tests.test_mcp_oauth',
    'tests.test_mcp_runtime',
    'tests.test_mcp_search_unit',
    'tests.test_message_deletion',
    'tests.test_migrate_storage_unit',
    'tests.test_microsoft_connection',
    'tests.test_microsoft_auth_unit',
    'tests.test_missed_call_record',
    'tests.test_people_call_socket_unit',
    'tests.test_multi_skill_selection',
    'tests.test_note_email',
    'tests.test_personal_data',
    'tests.test_privacy_policy',
    'tests.test_note_exports',
    'tests.test_note_language_contract',
    'tests.test_note_office_bridge',
    'tests.object_storage_test',
    'tests.test_notes',
    'tests.test_notification_inbox',
    'tests.test_office',
    'tests.test_office_ai',
    'tests.test_office_assistant',
    'tests.test_office_collaboration',
    'tests.test_office_folders',
    'tests.test_office_html',
    'tests.test_office_html_assistant',
    'tests.test_office_invoice',
    'tests.test_office_proxy',
    'tests.test_office_proxy_transport',
    'tests.test_office_word_colors',
    'tests.test_people_generation_quota',
    'tests.test_plugin_client',
    'tests.test_plugin_gateway',
    'tests.test_plugin_service',
    'tests.test_postgres_storage_unit',
    'tests.test_project_memory',
    'tests.test_project_memory_security',
    'tests.test_project_publish',
    'tests.test_projects_routes',
    'tests.test_projects_plugin_integration',
    'tests.test_quiz_review',
    'tests.test_rag',
    'tests.test_release_test_separation',
    'tests.test_research_office',
    'tests.test_research_engine',
    'tests.test_research_pdf_office',
    'tests.test_research_sources',
    'tests.test_research_usage',
    'tests.test_runner_security',
    'tests.test_runtime_approval_policy',
    'tests.test_s3_client',
    'tests.test_safe_xml',
    'tests.test_security_regressions',
    'tests.test_skill_snapshot',
    'tests.test_smtp_settings',
    'tests.test_specialist_quota',
    'tests.test_storage_home_usage',
    'tests.test_storage_restore_performance',
    'tests.test_stream_notification_wait',
    'tests.test_stream_replay',
    'tests.test_streaming',
    'tests.test_task_approval',
    'tests.test_task_usage',
    'tests.test_task_usage_recovery',
    'tests.test_toolbar_reminders',
    'tests.test_unified_search',
    'tests.test_visual_document_export',
    'tests.test_visual_export_routes',
    'tests.test_voice',
    'tests.test_worker_saving',
    'tests.test_worker_lifecycle',
    'tests.test_worker_wakeup',
    'tests.test_workflows',
    'tests.test_workspace_config_unit',
    'tests.test_zen_python_binding',
    'tests.test_spreadsheet_utils',
    'tests.test_presentation_delete',
    'tests.test_conversation_delete',
    'tests.test_conversation_office_export',
    'tests.test_app_groups_unit',
    'tests.test_mcp_catalog_coverage',
    'tests.test_mcp_oauth_coverage',
    'tests.test_main_oauth_bridge_massive',
    'tests.test_presentation_setup',
    'tests.test_microsoft_auth_coverage',
    'tests.test_personalization_coverage',
    'tests.test_projects_storage',
    'tests.test_workflows_engine',
    'tests.test_rag_storage_unit',
    'tests.test_sessions_unit',
    'tests.test_postgres_storage_coverage',
    'tests.test_migrate_blobs_unit',
    'tests.test_mcp_access_unit',
    'tests.test_blob_storage_ops',
    'tests.test_auth_database_unit',
    'tests.test_acp_bridge_unit',
    'tests.test_research_routes_unit',
    'tests.approval_policy_test',
    'tests.artifacts_test',
    'tests.test_app_actions.AppActionTests.test_today_uses_local_midnight_and_dst',
    'tests.test_app_actions.AppActionTests.test_no_caller_selected_owner_or_source',
    'tests.test_app_actions.AppActionTests.test_list_is_owner_scoped_and_creation_filtered',
    'tests.test_app_actions.AppActionTests.test_create_preserves_selected_collection_and_draft_color',
    'tests.test_app_actions.AppActionTests.test_create_uses_fixed_source_and_notifies_only_after_success',
    'tests.test_app_actions.AppActionTests.test_write_requires_owned_turn_and_retries_do_not_claim_revised_content',
    'tests.test_app_actions_integration',
    'tests.test_app_groups_database',
    'tests.test_chat_correlation_integration',
    'tests.test_notes_integration',
    'tests.test_toolbar_reminders_integration',
    'tests.test_workspace_integration_contract',
    'tests.test_plugin_projects_impact',
    'tests.test_plugin_tetragon_engine',
    'tests.test_plugin_tetragon_service',
    'tests.test_community',
    'tests.test_zero_cov_utils',
    'tests.test_learning_deep',
    'tests.test_learning_coach_isolated',
    'tests.test_people_deep',
    'tests.test_projects_office_deep',
    'tests.test_core_deep',
    'tests.test_projects_office_worker_deep',
    'tests.test_main_and_learning_deep',
    'tests.test_office_assistant_and_queue_deep',
    'tests.test_storage_community_flow_deep',
    'tests.test_decision_engine_and_hooks_deep',
    'tests.test_learning_audio_config_massive',
    'tests.test_team_backend_extra_coverage',
    'tests.test_team_backend_coverage',
    'tests.test_team_backend_deep_coverage',
)


def chromium_executable(environment):
    """Find a local browser for the optional real document-export tests."""
    configured = environment.get('RESEARCH_CHROMIUM_PATH')
    if configured:
        return configured if os.path.isfile(configured) and os.access(configured, os.X_OK) else None
    system_browser = shutil.which('chromium')
    if system_browser:
        return system_browser
    probe = subprocess.run(
        [sys.executable, '-c',
         'from playwright.sync_api import sync_playwright; '
         'p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()'],
        capture_output=True, text=True, env=environment, check=False,
    )
    path = probe.stdout.strip() if probe.returncode == 0 else ''
    return path if path and os.path.isfile(path) and os.access(path, os.X_OK) else None


def main():
    # A failed test/dependency check must not leave a previous report available
    # for the scanner to mistake for coverage of the current source tree.
    REPORT.unlink(missing_ok=True)
    if find_spec('coverage') is None:
        print('coverage.py is unavailable. Install test dependencies with:', file=sys.stderr)
        print(f'  {sys.executable} -m pip install -r requirements-test.txt', file=sys.stderr)
        return 1
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    source_paths = [str(ROOT), *(str(path) for path in (ROOT / 'plugins').iterdir() if path.is_dir())]
    environment['PYTHONPATH'] = os.pathsep.join([*source_paths, environment.get('PYTHONPATH', '')])
    command = [sys.executable, '-m', 'coverage']
    options = ['--rcfile=.coveragerc.sonar']
    tests = sys.argv[1:] or DEFAULT_TESTS
    try:
        subprocess.run([*command, 'erase', *options], cwd=ROOT, env=environment, check=True)
        subprocess.run([*command, 'run', *options, '-m', 'unittest', *tests], cwd=ROOT, env=environment, check=True)
        if not sys.argv[1:]:
            subprocess.run([*command, 'run', '--append', *options, 'tests/acp_team_gateway_test.py'], cwd=ROOT, env=environment, check=True)
            subprocess.run([*command, 'run', '--append', *options, 'tests/mcp_client_integration.py'], cwd=ROOT, env=environment, check=True)
            if environment.get('RUN_VISUAL_EXPORT_BROWSER_TESTS') != '1':
                browser = chromium_executable(environment)
                if browser:
                    browser_environment = {**environment, 'RUN_VISUAL_EXPORT_BROWSER_TESTS': '1', 'RESEARCH_CHROMIUM_PATH': browser}
                    print('Running visual document export tests with local Chromium.', flush=True)
                    subprocess.run([*command, 'run', '--append', *options, '-m', 'unittest', 'tests.test_visual_document_export.VisualBrowserTests'], cwd=ROOT, env=browser_environment, check=True)
                else:
                    print('Visual document export tests skipped: no local Chromium executable found.', file=sys.stderr)
        subprocess.run([*command, 'xml', *options], cwd=ROOT, env=environment, check=True)
    except subprocess.CalledProcessError as error:
        REPORT.unlink(missing_ok=True)
        return error.returncode
    print(f'Python coverage report ready: {REPORT.relative_to(ROOT)}')
    print('Run your usual SonarQube scanner from the project root to import it.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
