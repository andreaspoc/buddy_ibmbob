import { brandText } from '../lib/brand';
import { themeCssValue } from '../lib/themeColor';
import { scrollBehavior } from '../lib/motion';
import { AppCollaborationActivity, collaborationFromWorkLog } from './AppCollaborationActivity';
import { Bot } from '@carbon/icons-react';
import { skillDisplayName } from '../lib/skillNames';
import { AnswerActionLabel } from './AnswerActionLabel';
import { Toolbar } from './Toolbar';
import { DeleteQuestionButton } from './DeleteQuestionButton';
import './EmptyChat.css';
import { ShareToPeopleButton } from './ShareToPeople';
import { StickyNotes } from './StickyNotes';
import { parseStickyNotes } from '../lib/stickyNotes';
import { t, getLocale, useLanguage } from "../lib/i18n";
import { redactActivity } from '../lib/redaction';
import { ApprovalCard } from './ApprovalControls';
import type { ActionApproval } from '../types';
import { ClarificationCard } from './ClarificationCard';
import { QuizCard } from './QuizCard';
import { QuizResultsCard } from './QuizResultsCard';
import { parseQuizzes, parseQuizResults, quizAttempt } from '../lib/quiz';
import { parseClarifications, parseNextQuestions } from '../lib/clarification';
import { SlideCountPicker } from './SlideCountPicker';
import { presentationChatText } from '../lib/presentationChatText';
import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import type { ChatMessage, Mode, Skill, A2AAgent, PresentationTemplate } from '../types';
import * as api from '../api';
import { AnswerFeedback } from './AnswerFeedback';
import { AnswerContext } from './AnswerContext';
import { requestForAnswer } from '../lib/answerContext';
import { MarkdownView } from './MarkdownView';
import { formatTokens, formatBobcoins } from './Topbar';
import { VoiceInput } from './VoiceInput';
import { VoiceChat } from './VoiceChat';
import { speechText } from '../lib/voice';
import { SkillPicker } from './SkillPicker';
import { AgentPicker } from './AgentPicker';
import { ShortcutsModal } from './ShortcutsModal';
import { ChatTextSelection } from './ChatTextSelection';
import './ChatAttachments.css';
import './ChatContext.css';
import './ChatComposerTools.css';
import { CopyButton } from './CopyButton';

export function extractThinking(content: string, isStreaming?: boolean): { thoughts: string; cleanText: string } {
  if (!content) return { thoughts: '', cleanText: '' };

  const closedMatch = content.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
  if (closedMatch) {
    const thoughts = closedMatch[1].trim();
    const cleanText = content.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>\s*/i, '').trim();
    return { thoughts, cleanText };
  }

  if (isStreaming) {
    const openMatch = content.match(/<(?:think|thinking)>([\s\S]*)$/i);
    if (openMatch) {
      const thoughts = openMatch[1].trim();
      const cleanText = content.replace(/<(?:think|thinking)>[\s\S]*$/i, '').trim();
      return { thoughts, cleanText };
    }
  }

  return { thoughts: '', cleanText: content };
}

import { extractBobdeck, extractHtmlDeck, extractLiveBobdeck } from '../lib/extractDeck';
import { modRegistry } from '../mods';

interface ChatViewProps {
  talkToAgentsMode?: boolean;
  agentPickerRequest?: number;
  onManageAgents?: () => void;
  attachedAgents?: string[];
  onChangeAttachedAgents?: (slugs: string[]) => void;
  onManageSkills?: () => void;
  onAddSkill?: () => void;
  composerTools?: React.ReactNode;
  composerShortcuts?: React.ReactNode;
  composerReferences?: React.ReactNode;
  projectName?: string;
  projects?: Array<{ id: string; name: string }>;
  projectId?: string;
  onSelectProject?: (id: string) => void;
  onChangeProject?: () => void;
  onChangeMode?: (mode: string) => void;
  onChangeAgent?: (agent: string) => void;
  configuredTools?: string[];
  onManageTools?: () => void;
  readOnly?: boolean;
  voiceEnabled?: boolean;
  guidedSkill?: { sessionId: string; name: string } | null;
  messages: ChatMessage[];
  sessionId?: string;
  isStreaming: boolean;
  activeMode: string;
  slideCount: number;
  onSlideCountChange: (count: number) => void;
  activeAgent: string;
  modes: Mode[];
  skills: Skill[];
  agents: A2AAgent[];
  templates: PresentationTemplate[];
  selectedTemplateId: string;
  onVoiceSend?: (prompt: string) => void;
  onFollowUp?: (prompt: string, mode?: string, format?: 'pptx' | 'html', templateId?: string) => void;
  onSendMessage: (prompt: string, forceMode?: string, format?: 'pptx' | 'html', templateId?: string, skillName?: string | string[]) => void;
  onApprovalDecision: (approval: ActionApproval, decision: 'approve' | 'approve_task' | 'reject') => Promise<void>;
  onUploadFile: (file: File) => Promise<api.UploadedFileResponse>;
  onStop: () => void;
  onGuideResponse?: (text: string) => Promise<void>;
  canGuideResponse?: boolean;
  onFilesChanged?: () => void;
  onViewAttachment?: (path: string) => void;
  onOpenTemplateModal: () => void;
  onGenerateDeckFromMessage?: (content: string) => void;
  onBranch?: (turnIndex: number) => Promise<void>;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  deletingMessage?: boolean;
  isPanelActive?: boolean;
  onTogglePanel?: () => void;
}

export const ChatView: React.FC<ChatViewProps> = ({
  talkToAgentsMode = false,
  agentPickerRequest = 0,
  onManageAgents,
  attachedAgents = [],
  onChangeAttachedAgents,
  onManageSkills,
  onAddSkill,
  composerTools,
  composerShortcuts,
  composerReferences,
  projectName,
  projects = [],
  projectId = '',
  onSelectProject,
  onChangeProject,
  onChangeMode,
  onChangeAgent,
  configuredTools = [],
  onManageTools,
  readOnly = false,
  voiceEnabled = true,
  messages,
  guidedSkill,
  sessionId,
  isStreaming,
  activeMode,
  slideCount,
  onSlideCountChange,
  activeAgent,
  modes,
  skills,
  agents,
  templates,
  selectedTemplateId,
  onSendMessage,
  onFollowUp,
  onVoiceSend,
  onApprovalDecision,
  onUploadFile,
  onStop,
  onGuideResponse,
  canGuideResponse = false,
  onFilesChanged,
  onViewAttachment,
  onOpenTemplateModal,
  onGenerateDeckFromMessage,
  onBranch,
  onDeleteMessage,
  deletingMessage = false,
}) => {
  useLanguage();
  const [skillsOpen, setSkillsOpen] = useState(false);
  useEffect(() => {
    if (!agentPickerRequest) return;
    setSkillsOpen(true);
    requestAnimationFrame(() => {
      document.getElementById('chat-skill-picker')?.scrollIntoView({ block: 'nearest' });
      document.querySelector<HTMLInputElement>('#chat-skill-picker input')?.focus({ preventScroll: true });
    });
  }, [agentPickerRequest]);
  useEffect(() => setSkillsOpen(false), [sessionId]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  useEffect(() => setOutlineOpen(false), [sessionId]);
  const [input, setInput] = useState('');
  const [quotes, setQuotes] = useState<Array<{ id: number; text: string }>>([]);
  const quoteIdRef = useRef(0);
  useEffect(() => { setQuotes([]); }, [sessionId]);
  const [skillSelection, setSkillSelection] = useState<{sessionId: string | undefined; names: string[]}>({ sessionId, names: [] });
  useEffect(() => { if (guidedSkill && guidedSkill.sessionId === sessionId) setSkillSelection({sessionId, names: [guidedSkill.name]}); }, [guidedSkill, sessionId]);
  const selectedSkills = !talkToAgentsMode && skillSelection.sessionId === sessionId
    ? skillSelection.names.filter(name => skills.some(skill => skill.name === name)) : [];
  const selectedSkill = selectedSkills[0] || '';
  const skillPayload = selectedSkills.length > 1 ? selectedSkills : selectedSkill || undefined;
  const isSavingFiles = messages.some(message => message.isStreaming && message.deliveryState === 'saving');
  const guidanceEnabled = isStreaming && !isSavingFiles && canGuideResponse && Boolean(onGuideResponse);
  const [guidancePending, setGuidancePending] = useState(false);
  const guidancePendingRef = useRef(false);
  const [guidanceStatus, setGuidanceStatus] = useState<{ text: string; error: boolean } | null>(null);
  const composerSessionRef = useRef(sessionId);
  useEffect(() => { composerSessionRef.current = sessionId; }, [sessionId]);
  useEffect(() => {
    setGuidanceStatus(null);
  }, [sessionId, isStreaming]);
  const [showSlash, setShowSlash] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [readRequest, setReadRequest] = useState<{text: string; nonce: number} | null>(null);
  useEffect(() => {
    if (isStreaming) setShowSlash(false);
  }, [isStreaming]);
  const [webSearchSelection, setWebSearchActive] = useState(false);
  const hasWebSearchSkill = skills.some(skill => skill.name === 'research-buddy');
  const webSearchActive = webSearchSelection && hasWebSearchSkill;
  const [webSearchReady, setWebSearchReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/workflows/capabilities', { signal: controller.signal }).then(res => {
      if (!res.ok) throw new Error('Capabilities unavailable');
      return res.json();
    }).then(data => setWebSearchReady(Boolean(data.web_search))).catch(() => {});
    return () => controller.abort();
  }, []);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashQuery = /^\/[^\n]*$/.test(input) ? input.slice(1).toLowerCase() : '';
  const visibleSkills = skills.filter(sk => `${sk.name} ${skillDisplayName(sk.name)} ${t(sk.description)}`.toLowerCase().includes(slashQuery));
  const visibleModes = modes.filter(m => `mode ${m.slug}`.includes(slashQuery));
  const visibleAgents = agents.filter(a => `agent ${a.slug}`.includes(slashQuery));
  const visibleModCommands = [{ command: '/preview', description: 'Open or close Presentation Studio beside chat', modName: 'Workspace', modIcon: '📊' }, ...modRegistry.getActiveCommands()].filter(cmd => `${cmd.command} ${t(cmd.description)}`.toLowerCase().includes(slashQuery));
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [fileDecks, setFileDecks] = useState<Record<string, { deck: any; rawJson: string }>>({});
  useEffect(() => {
    setFileDecks({});
  }, [sessionId]);
  const [attachedFile, setAttachedFile] = useState<api.UploadedFileResponse | null>(null);
  const [documentCheckError, setDocumentCheckError] = useState<string | null>(null);
  const [documentRetrying, setDocumentRetrying] = useState(false);
  const documentRetryController = useRef<AbortController | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  useEffect(() => {
    setAttachedFile(null);
    setUploadError(null);
    setDocumentCheckError(null);
    setDocumentRetrying(false);
    documentRetryController.current?.abort();
    return () => { documentRetryController.current?.abort(); };
  }, [sessionId]);
  const documentPending = Boolean(attachedFile?.document && attachedFile.document.status !== 'ready');
  useEffect(() => {
    setDocumentCheckError(null);
    if (!sessionId || !attachedFile?.document || ['ready', 'failed'].includes(attachedFile.document.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const path = attachedFile.path;
    let failures = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/documents/preview?path=${encodeURIComponent(path)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          setDocumentCheckError(response.status === 404 ? 'This document is no longer available. Remove it and attach it again.' : 'Document access could not be verified. Sign in again before attaching this file.');
          return;
        }
        if (!response.ok) throw new Error('Could not check document preparation. Retrying automatically…');
        const document = await response.json();
        if (controller.signal.aborted) return;
        failures = 0;
        setDocumentCheckError(null);
        setAttachedFile(current => current?.path === path ? { ...current, document } : current);
        if (document.status !== 'ready' && document.status !== 'failed') timer = setTimeout(poll, 1500);
        else if (document.status === 'ready') onFilesChanged?.();
      } catch {
        if (!controller.signal.aborted) {
          setDocumentCheckError('Could not check document preparation. Retrying automatically…');
          timer = setTimeout(poll, Math.min(1500 * 2 ** failures++, 10000));
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, attachedFile?.path, attachedFile?.document?.status]);
  const retryDocumentPreparation = async () => {
    if (!sessionId || !attachedFile || documentRetrying) return;
    const submittedSession = sessionId;
    const submittedFile = attachedFile;
    const controller = new AbortController();
    documentRetryController.current?.abort();
    documentRetryController.current = controller;
    setDocumentRetrying(true);
    setDocumentCheckError(null);
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/documents/prepare?path=${encodeURIComponent(attachedFile.path)}`, { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error('Could not retry document preparation. Please try again.');
      if (controller.signal.aborted || composerSessionRef.current !== submittedSession) return;
      setAttachedFile(current => current === submittedFile ? { ...current, document: { path: current.path, status: 'queued' } } : current);
    } catch (error) {
      if (!controller.signal.aborted && composerSessionRef.current === submittedSession) setDocumentCheckError(error instanceof Error ? error.message : 'Could not retry document preparation.');
    } finally {
      if (!controller.signal.aborted && composerSessionRef.current === submittedSession) setDocumentRetrying(false);
    }
  };
  const [isDragging, setIsDragging] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const followOutputRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastScrollRef = useRef({ top: 0, height: 0 });
  const previousReplyRef = useRef<{ id: string; streaming: boolean } | null>(null);
  const followFrameRef = useRef<number | null>(null);
  const scheduleFollow = () => {
    if (followFrameRef.current !== null) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      const scroller = scrollRef.current;
      if (!scroller || !followOutputRef.current) return;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (Math.abs(scroller.scrollTop - target) > 1) scroller.scrollTop = target;
      lastScrollRef.current = { top: scroller.scrollTop, height: scroller.scrollHeight };
    });
  };
  useEffect(() => () => { if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current); }, []);

  // Global keyboard shortcuts (Cmd+/ or Ctrl+/ for shortcuts sheet, Cmd+K for focus)
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Escape' && isShortcutsOpen) {
        setIsShortcutsOpen(false);
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, [isShortcutsOpen]);

  const scrollToBottom = (instant = false) => {
    followOutputRef.current = true;
    if (scrollRef.current) {
      if (instant) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      } else {
        scrollRef.current.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: scrollBehavior(),
        });
      }
    }
  };

  useLayoutEffect(() => {
    followOutputRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    const handlePauseFollow = () => {
      followOutputRef.current = false;
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    };
    window.addEventListener('buddy-note-flight-scroll', handlePauseFollow);
    return () => window.removeEventListener('buddy-note-flight-scroll', handlePauseFollow);
  }, []);

  useLayoutEffect(() => {
    const reply = messages[messages.length - 1];
    if (reply?.role === 'assistant') {
      const previous = previousReplyRef.current;
      // A completed test can be much taller than the streamed introduction.
      // Keep its first questions in view instead of following to Submit.
      if (previous?.id === reply.id && previous.streaming && !reply.isStreaming && parseQuizzes(reply.content).quizzes.length) followOutputRef.current = false;
      previousReplyRef.current = { id: reply.id, streaming: Boolean(reply.isStreaming) };
    }
    scheduleFollow();
  }, [messages]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    // Final question cards, images and diagrams can resize after the last
    // text event. Follow their actual height, without waiting for new text.
    const observer = new ResizeObserver(() => {
      scheduleFollow();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    if (distanceFromBottom <= 14) {
      followOutputRef.current = true;
    } else if (distanceFromBottom > 48 && scrollTop < lastScrollRef.current.top - 1) {
      // Content growth alone must not be mistaken for scrolling away.
      followOutputRef.current = false;
    }
    lastScrollRef.current = { top: scrollTop, height: scrollHeight };
    setShowScrollBottom(distanceFromBottom > 72);
  };

  const handleContainerWheel = (e: React.WheelEvent) => {
    const target = e.target as HTMLElement | null;
    if (target) {
      // If user is inside a scrollable textarea or inner pre/code block, don't intercept
      if (target.tagName === 'TEXTAREA' && target.scrollHeight > target.clientHeight) {
        return;
      }
      let parent: HTMLElement | null = target;
      while (parent && parent !== scrollRef.current && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
          if (parent === scrollRef.current) break;
          return;
        }
        parent = parent.parentElement;
      }
    }
    if (scrollRef.current) {
      if (e.deltaY < 0) followOutputRef.current = false;
      // The conversation already receives native wheel scrolling. Applying
      // deltaY here as well makes every gesture move twice.
      if (target && scrollRef.current.contains(target)) return;
      scrollRef.current.scrollTop += e.deltaY;
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    setShowSlash(!isStreaming && /^\/[^\s]*$/.test(e.target.value));
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (showSlash && e.key === 'Escape') {
      e.preventDefault();
      setShowSlash(false);
      return;
    }
    if (showSlash && ['ArrowDown', 'Tab', 'Enter'].includes(e.key) && !e.shiftKey) {
      const first = slashMenuRef.current?.querySelector<HTMLButtonElement>('button');
      if (first) {
        e.preventDefault();
        if (e.key === 'ArrowDown') first.focus();
        else first.click();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file || isUploading || isStreaming) return;
    const documentFile = /\.(pdf|docx|md|txt)$/i.test(file.name);
    const limit = documentFile ? 25 : 50;
    if (file.size > limit * 1024 * 1024) {
      setUploadError(`This file is too large. The limit is ${limit} MB.`);
      return;
    }
    const uploadSession = sessionId;
    setIsUploading(true);
    setUploadName(file.name);
    setUploadError(null);
    try {
      const res = await onUploadFile(file);
      if (composerSessionRef.current !== uploadSession && composerSessionRef.current !== res.session_id) return;
      setAttachedFile(res);
      onFilesChanged?.();
      if (!input.trim()) {
        if (res.is_spreadsheet) {
          setInput(`Please inspect ${res.filename} and summarize the key columns, row count, and findings.`);
        } else {
          setInput(`Please review the uploaded file ${res.filename}.`);
        }
      }
    } catch (err: any) {
      if (composerSessionRef.current === uploadSession) setUploadError(err.message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFileUpload(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFileUpload(file);
    }
  };

  const renderPicker = () => {
    if (talkToAgentsMode) {
      return (
        <AgentPicker
          agents={agents}
          selected={attachedAgents}
          disabled={isStreaming || isUploading}
          onManage={onManageAgents}
          onChange={slugs => {
            onChangeAttachedAgents?.(slugs);
            if (slugs.length) onChangeAgent?.('');
          }}
        />
      );
    }
    return (
      <SkillPicker
        skills={skills}
        selected={selectedSkills}
        disabled={isStreaming || isUploading}
        onSelect={chooseSkill}
        onManage={onManageSkills}
        onAdd={onAddSkill}
      />
    );
  };

  const chooseSkill = (name: string) => {
    setSkillSelection({ sessionId, names: !name ? [] : selectedSkills.includes(name)
      ? selectedSkills.filter(item => item !== name) : selectedSkills.length < 6 ? [...selectedSkills, name] : selectedSkills });
    setShowSlash(false);
    setWebSearchActive(false);
    if (name) onChangeAgent?.('');
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleSubmit = async () => {
    let text = input.trim();
    const quotedContext = quotes.length ? `\n\n${t('Selected text:')}\n${quotes.map(quote => quote.text.split('\n').map(line => `> ${line}`).join('\n')).join('\n\n')}` : '';
    if (isStreaming) {
      if (!guidanceEnabled || !onGuideResponse || !text || guidancePendingRef.current) return;
      const submittedSession = sessionId;
      const submittedInput = input;
      guidancePendingRef.current = true;
      setGuidancePending(true);
      setGuidanceStatus(null);
      try {
        await onGuideResponse(text + quotedContext);
        if (composerSessionRef.current === submittedSession) {
          setInput(current => current === submittedInput ? '' : current);
          setQuotes(current => current.filter(quote => !quotes.some(submitted => submitted.id === quote.id)));
          setGuidanceStatus({ text: brandText('Guidance sent to Buddy.'), error: false });
        }
      } catch (error) {
        if (composerSessionRef.current === submittedSession) {
          setGuidanceStatus({ text: error instanceof Error ? error.message : 'Could not send guidance. Please try again.', error: true });
        }
      } finally {
        guidancePendingRef.current = false;
        setGuidancePending(false);
      }
      return;
    }
    if (!text && !attachedFile) return;
    if (isStreaming || isUploading || documentPending) return;

    if (webSearchActive && !selectedSkill && !activeAgent && text && !text.startsWith('/')) {
      text = `/research-buddy ${text}`;
    }
    if (text) text += quotedContext;

    if (attachedFile) {
      const prefix = `[Attached ${attachedFile.is_spreadsheet ? 'spreadsheet' : attachedFile.document ? 'document' : 'file'}: ${attachedFile.filename}]\n`;
      const promptToSend = text
        ? `${prefix}${text}`
        : `${prefix}Please inspect the attached file and summarize the key findings.${quotedContext}`;
      onSendMessage(promptToSend, undefined, undefined, undefined, skillPayload);
      setAttachedFile(null);
    } else {
      onSendMessage(text, undefined, undefined, undefined, skillPayload);
    }

    setInput('');
    setQuotes([]);
    setShowSlash(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setTimeout(() => scrollToBottom(true), 10);
  };

  const activeAgentObj = agents.find((a) => a.slug === activeAgent);
  const currentTemplate = templates.find((t) => t.id === selectedTemplateId);



  useEffect(() => {
    if (!sessionId || readOnly) return;
    let disposed = false;
    messages.forEach((msg) => {
      if (msg.role !== 'assistant') return;
      if (msg.isStreaming || msg.presentationDeleted) return;
      const bobData = extractBobdeck(msg.content);
      const fn = (bobData as any)?.filename;
      if (fn) {
        const key = `${sessionId}:${fn}`;
        if (!fileDecks[key]) {
          api.fetchDeckByPath(fn, sessionId).then((data) => {
            if (!disposed && data && data.slides && Array.isArray(data.slides)) {
              setFileDecks((prev) => ({
                ...prev,
                [key]: { deck: data, rawJson: JSON.stringify(data, null, 2) },
              }));
            }
          }).catch(() => {});
        }
      }
    });
    return () => { disposed = true; };
  }, [messages, sessionId, activeMode, fileDecks, readOnly]);

  const outlineItems = messages.flatMap(message => {
    if (message.content.trimStart().startsWith('Quiz submission:')) return [];
    const anchor = `chat-message-${encodeURIComponent(message.id)}`;
    if (message.role === 'user') return [{ anchor, kind: 'Prompt', label: (message.displayPrompt || message.content).replace(/^\[Attached [^\n]+\]\s*/i, '').replace(/\s+/g, ' ').trim() || t('Attached file') }];
    const files = [...message.content.matchAll(/\[([^\[\]\n]+)\]\(([^)\n]+)\)/g)].filter(match => !/^https?:/i.test(match[2]) && /(?:\/files\/|\/artifacts\/|\/download|\.(?:pdf|docx|pptx|xlsx|csv|html|md|txt|png|svg)(?:[?#]|$))/i.test(match[2]));
    const labels = [...new Set(files.map(match => match[1]))];
    if (message.deckJson || message.htmlFilename || extractBobdeck(message.content) || extractHtmlDeck(message.content)) labels.unshift(t('Presentation'));
    return labels.map(label => ({ anchor, kind: 'Artifact', label }));
  });
  const jumpToMessage = (anchor: string) => {
    const target = document.getElementById(anchor);
    const scroller = scrollRef.current;
    if (!target || !scroller) return;
    followOutputRef.current = false;
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.focus({ preventScroll: true });
  };

  return (
    <div className="conversation-container" onWheel={handleContainerWheel}>
      <Toolbar className="chat-context-bar" aria-label={t('Conversation context')}>
        {!readOnly && <>
        {onSelectProject ? <label className="chat-context-chip"><span>{t('Project')}</span><select aria-label={t('Conversation project')} value={projectId} disabled={readOnly || isStreaming} onChange={event => onSelectProject(event.target.value)}><option value="">{t('Personal')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label> : onChangeProject ? <button type="button" className="chat-context-chip" onClick={onChangeProject} title={t('Change project')}><span>{t('Project')}</span><strong>{projectName || t('Personal')}</strong></button> : <span className="chat-context-chip"><span>{t('Project')}</span><strong>{projectName || t('Personal')}</strong></span>}
        <label className="chat-context-chip"><span>{t('Mode')}</span><select aria-label={t('Conversation mode')} value={activeMode} disabled={readOnly || isStreaming || !onChangeMode} onChange={event => onChangeMode?.(event.target.value)}>{!modes.some(mode => mode.slug === activeMode) && <option value={activeMode}>{activeMode || t('Automatic')}</option>}{modes.map(mode => <option key={mode.slug} value={mode.slug}>{mode.name || mode.slug}</option>)}</select></label>
        <label className="chat-context-chip"><span>{t('Agent')}</span><select aria-label={t('Conversation agent')} value={activeAgent} disabled={readOnly || isStreaming || !onChangeAgent} onChange={event => onChangeAgent?.(event.target.value)}><option value="">{brandText("Buddy")}</option>{agents.map(agent => <option key={agent.slug} value={agent.slug}>{agent.name}</option>)}</select></label>
        <button type="button" className="chat-context-chip" onClick={onManageTools} disabled={!onManageTools} title={configuredTools.join(', ') || t('No connections configured')}><span>{t('Available connections')}</span><strong>{configuredTools.length}</strong></button>
        {selectedSkills.map(name => <span key={name} className="chat-context-chip"><span>{t('Skill')}</span><strong>{skillDisplayName(name)}</strong></span>)}
        {webSearchActive && <span className="chat-context-chip"><strong>{t('Web search on')}</strong></span>}
        {attachedFile && <button type="button" className="chat-context-chip chat-context-file" onClick={() => onViewAttachment?.(attachedFile.path)} disabled={!onViewAttachment} title={attachedFile.filename}><span>{t('Attached')}</span><strong>{attachedFile.filename}</strong></button>}
        </>}
        {outlineItems.length > 0 && <button type="button" className={`chat-outline-toggle${outlineOpen ? ' active' : ''}`} aria-expanded={outlineOpen} aria-controls="chat-conversation-outline" onClick={() => setOutlineOpen(open => !open)}>{t('Outline')} <span aria-hidden="true">{outlineOpen ? '⌃' : '⌄'}</span></button>}
      </Toolbar>
      {outlineOpen && outlineItems.length > 0 && <nav id="chat-conversation-outline" className="chat-conversation-outline" aria-label={t('Conversation outline')}><div className="chat-outline-heading">{t('Jump to a prompt or generated file')}</div><ol>{outlineItems.map((item, index) => <li key={`${item.anchor}-${index}`}><button type="button" onClick={() => jumpToMessage(item.anchor)}><span className="chat-outline-kind">{t(item.kind)}</span><span>{item.label}</span></button></li>)}</ol></nav>}

      {/* PRESENTATION MODE BANNER */}
      {activeMode === 'presentation' && (
        <div className="presentation-banner" id="presentation-banner">
          <div className="presentation-banner-info">
            <span className="presentation-banner-icon" aria-hidden="true">📊</span>
            <div>
              <div className="presentation-banner-title">
                {t("Presentation Studio Mode Active")}</div>
              <div className="presentation-template-label">
                {t("Template:")}{' '}
                <span className="template-name-highlight">
                  {currentTemplate ? currentTemplate.title : t("Purple Starter")}
                </span>{' '}
                {t("· 16:9 Widescreen BobDeck")}</div>
            </div>
          </div>
          <SlideCountPicker value={slideCount} onChange={onSlideCountChange} disabled={isStreaming} />
          <button
            type="button"
            className="presentation-banner-btn"
            onClick={onOpenTemplateModal}
          >
            {t("Change Template")}</button>
        </div>
      )}

      {/* MESSAGES SCROLL AREA */}
      {!readOnly && <ChatTextSelection containerRef={contentRef} sessionId={sessionId} onQuote={text => {
        setQuotes(current => current.some(quote => quote.text === text) ? current : [...current, { id: ++quoteIdRef.current, text }]);
        setShowSlash(false);
        textareaRef.current?.focus({ preventScroll: true });
      }} />}
      <section
        ref={scrollRef}
        className={`conversation${messages.length === 0 ? ' conversation-new' : ''}`}
        aria-label={t("Conversation")}
        onScroll={handleScroll}
        onPointerDownCapture={(event) => {
          if ((event.target as HTMLElement).closest('.clarification-card, .quiz-card, .quiz-results, .intelligent-answer')) followOutputRef.current = false;
        }}
        onFocusCapture={(event) => {
          if ((event.target as HTMLElement).closest('.clarification-card, .quiz-card, .quiz-results, .intelligent-answer')) followOutputRef.current = false;
        }}
      >
        <div ref={contentRef} className="conversation-content">
        {messages.length === 0 ? (
          <div className="welcome welcome-buddy">
            <div className="welcome-buddy-hero">
              <div className="welcome-icon" aria-hidden="true">{talkToAgentsMode ? <Bot size={24} /> : '✦'}</div>
              <div className="welcome-top-row">
                <div className="eyebrow">{talkToAgentsMode ? t("Buddy · Agent Collaboration") : t("Buddy")}</div>
              </div>
              <h2>{talkToAgentsMode ? t("Boost your Productivity with other Buddys") : t("How can I make your life easier today?")}</h2>
              <p>{t(talkToAgentsMode ? 'Select which connected agents should join the conversation. Buddy will coordinate their capabilities and delegate seamlessly.' : 'Choose a skill below, or ask Buddy directly. Add your question and any files when you are ready.')}</p>
            </div>
            {!readOnly && <div id="chat-skill-picker">{renderPicker()}</div>}
          </div>
        ) : (
          <div className="messages">
            {messages.map((originalMessage, messageIndex) => {
              const msg = { ...originalMessage, workLog: redactActivity(originalMessage.workLog), toolsUsed: redactActivity(originalMessage.toolsUsed), approvals: redactActivity(originalMessage.approvals) };
              if (msg.role === 'user') {
                if (msg.content.trimStart().startsWith('Quiz submission:')) return null;
                const attachment = msg.content.match(/^\[Attached (spreadsheet|file|document): ([^\n]+)\]\s*\n?/i);
                const messageText = attachment ? msg.content.slice(attachment[0].length) : msg.content;
                return (
                  <div key={msg.id} id={`chat-message-${encodeURIComponent(msg.id)}`} tabIndex={-1} data-message-id={msg.id} data-correlation-id={msg.correlationId} data-job-id={msg.jobId} data-chat-id={msg.workspaceId} className="message user">
                    <div className="bubble">
                      {attachment && (
                        <div className="message-attachment" aria-label={t("Attached file: {0}", [attachment[2]])}>
                          <span className="message-attachment-icon" aria-hidden="true">
                            <svg width="22" height="26" viewBox="0 0 24 28" fill="none"><path d="M4 1h10l6 6v19H4V1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 1v7h6M8 13h8M8 17h8M8 21h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                          </span>
                          <span className="message-attachment-details">
                            <strong>{attachment[2]}</strong>
                            <small>{attachment[2].split('.').pop()?.toUpperCase()} · {attachment[1].toLowerCase() === 'spreadsheet' ? t("Spreadsheet") : t("Attached file")}</small>
                          </span>
                        </div>
                      )}
                      {msg.noteReferences?.map(note => <div className="message-attachment" key={`note:${note.id}`}><span aria-hidden="true">▤</span><span className="message-attachment-details"><strong>{note.title}</strong><small>{t('Notes')}{note.truncated ? ` · ${t('Partial document context')}` : ''}</small></span></div>)}
                      {msg.officeReferences?.map(file => <div className="message-attachment" key={file.id}><span aria-hidden="true">▦</span><span className="message-attachment-details"><strong>{file.name}</strong><small>{t('Office Suite')}{file.truncated ? ` · ${t('Partial document context')}` : ''}</small></span></div>)}
                      {messageText && <p>{messageText}</p>}
                      {!readOnly && onDeleteMessage && sessionId && <DeleteQuestionButton disabled={isStreaming || deletingMessage} onClick={() => void onDeleteMessage(msg.id)} />}
                    </div>
                  </div>
                );
              }

              // Assistant message
              const { thoughts: explicitThoughts, cleanText: textWithoutThink } = extractThinking(msg.content, msg.isStreaming);
              const bobdeckData = msg.presentationDeleted ? null : extractBobdeck(textWithoutThink);
              const htmlDeckData = msg.presentationDeleted ? null : extractHtmlDeck(textWithoutThink, Boolean(msg.isStreaming)) || (!msg.isStreaming && (msg.mode === 'presentation' || msg.isPresentation) && msg.htmlFilename ? { filename: msg.htmlFilename, cleanText: textWithoutThink } : null);
              let resolvedDeck = msg.presentationDeleted ? null : msg.deckJson || null;
              let displayText = msg.voiceMode ? speechText(textWithoutThink) : textWithoutThink;

              if (!resolvedDeck && bobdeckData) {
                if ((bobdeckData as any).deck) {
                  resolvedDeck = (bobdeckData as any).deck;
                  displayText = (bobdeckData as any).cleanText;
                } else if ((bobdeckData as any).filename && sessionId && !msg.isStreaming) {
                  const key = `${sessionId}:${(bobdeckData as any).filename}`;
                  if (fileDecks[key]) {
                    resolvedDeck = fileDecks[key].deck;
                  }
                  displayText = (bobdeckData as any).cleanText;
                }
              } else if (htmlDeckData) {
                displayText = htmlDeckData.cleanText || textWithoutThink;
              }

              const quizContent = parseQuizzes(displayText, Boolean(msg.isStreaming));
              const quizReview = parseQuizResults(quizContent.text, Boolean(msg.isStreaming));
              const stickyNotes = parseStickyNotes(quizReview.text, Boolean(msg.isStreaming));
              displayText = stickyNotes.text;
              const sourceRequest = messages.slice(0, messageIndex).reverse().find(previous => previous.role === 'user')?.content || '';
              const suppressFollowups = msg.voiceMode || quizContent.quizzes.length > 0 || Boolean(quizContent.error) || (sourceRequest.startsWith('Quiz submission:') && quizReview.results.length === 0);
              const clarification = parseClarifications(displayText, Boolean(msg.isStreaming));
              const nextQuestions = parseNextQuestions(clarification.text, Boolean(msg.isStreaming));
              displayText = nextQuestions.text;

              // Parse the original source for the viewer, but never stream it into chat.
              displayText = presentationChatText(displayText, Boolean(
                msg.mode === 'presentation' || resolvedDeck || htmlDeckData ||
                (msg.isStreaming && activeMode === 'presentation')
              ));

              const isGeneratingDeck = msg.isStreaming && Boolean(
                activeMode === 'presentation' ||
                msg.mode === 'presentation' ||
                /```(?:bobdeck)/i.test(msg.content) ||
                msg.content.toLowerCase().includes('.bobdeck') ||
                extractLiveBobdeck(textWithoutThink) ||
                resolvedDeck ||
                htmlDeckData
              );
              const hasDeck = !msg.isStreaming && Boolean(resolvedDeck || htmlDeckData);

              return (
                <div key={msg.id} id={`chat-message-${encodeURIComponent(msg.id)}`} tabIndex={-1} data-message-id={msg.id} data-correlation-id={msg.correlationId} data-job-id={msg.jobId} data-chat-id={msg.workspaceId} className={`message assistant ${hasDeck ? 'has-deck-message' : ''}`}>
                  <div
                    className={`avatar ${msg.isStreaming && msg.deliveryState !== 'saving' ? 'is-generating' : ''}`}
                    title={msg.isStreaming && msg.deliveryState !== 'saving' ? t("Buddy is thinking & generating…") : t("Buddy")}
                  >
                    {msg.isStreaming && msg.deliveryState !== 'saving' ? <span className="avatar-spark" aria-label={t("Generating")}>✦</span> : 'B'}
                  </div>
                  <div className={`message-body ${hasDeck ? 'has-deck-body' : ''}`}>
                    {msg.guidance?.map(note => (
                      <div key={note.id} className="message user chat-guidance" aria-label={t("Your guidance")}>
                        <div className="bubble">
                          <small className="chat-guidance-heading"><span>{t("Your guidance")}</span><span className="chat-guidance-status" data-status={note.status}>{note.status === 'applied' ? t("Applied") : t("Received")}</span></small>
                          <p>{note.text}</p>
                        </div>
                      </div>
                    ))}
                    <div className={`bubble ${hasDeck ? 'has-deck-bubble' : ''}`}>
                      {msg.approvals?.map(approval => <ApprovalCard key={approval.approval_id}
                        approval={approval} onDecide={onApprovalDecision} disabled={!isStreaming} />)}

                      {/* Markdown Body with Mermaid, Charts, and Table support */}
                      <AppCollaborationActivity activities={collaborationFromWorkLog(msg.workLog)} />
                      {displayText ? (
                        <MarkdownView compactDiagrams consolidatedSources messageId={msg.id} content={displayText} isStreaming={msg.isStreaming && msg.deliveryState !== 'saving'} sessionId={sessionId} readOnly={readOnly} onPrompt={isStreaming || readOnly ? undefined : onSendMessage} />
                      ) : (!msg.isStreaming && (resolvedDeck || (bobdeckData as any)?.filename || htmlDeckData) && (
                        <p style={{ margin: '0 0 10px 0', color: '#4b5563', fontSize: '13.5px' }}>
                          {t("Here is your presentation:")}</p>
                      ))}

                      {stickyNotes.notes.length > 0 && !msg.isStreaming && <StickyNotes notes={stickyNotes.notes} sessionId={sessionId} messageId={msg.id} readOnly={readOnly} />}

                      {quizContent.error && !msg.isStreaming && <p role="alert">{t('This quiz could not be loaded. Ask Bob to recreate the test; its answer key has not been displayed.')}</p>}
                      {quizContent.quizzes.map(quiz => {
                        const reviewMessage=messages.slice(messageIndex+1).find(message=>message.role==='assistant' && !message.isStreaming && parseQuizResults(message.content).results.some(result=>result.quiz_key===quiz.key));
                        return <QuizCard key={quiz.key} quiz={quiz} sessionId={sessionId} disabled={isStreaming || readOnly}
                        submittedAnswers={quizAttempt(messages.slice(messageIndex + 1), quiz.key)}
                        onSubmit={prompt => onSendMessage(prompt, 'agent')}
                        onViewResults={reviewMessage?()=>contentRef.current?.querySelector(`[data-message-id="${CSS.escape(reviewMessage.id)}"]`)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}):undefined} />;
                      })}
                      {quizReview.error && !msg.isStreaming && <p role="alert">{t('This test review could not be loaded. Submit your saved answers again to retry grading.')}</p>}
                      {quizReview.results.map(result => <QuizResultsCard key={result.quiz_key} result={result} sessionId={sessionId} disabled={isStreaming || readOnly} onPractice={prompt => onSendMessage(prompt, 'agent')} />)}

                      {(() => {
                        const formQuestions = clarification.questions.length > 0
                          ? clarification.questions
                          : (!readOnly && nextQuestions.options.length > 0)
                            ? [{
                                question: t("What would you like to do next?"),
                                options: nextQuestions.options,
                                context: t("Choose a suggested next step or specify your preferred direction below."),
                              }]
                            : [];
                        return !suppressFollowups && formQuestions.length > 0 && !msg.isStreaming ? (
                          <ClarificationCard questions={formQuestions} disabled={isStreaming || readOnly}
                            answered={messages.slice(messageIndex + 1).some(next => next.role === 'user')}
                            cancelled={Boolean(messages.slice(messageIndex + 1).find(next => next.role === 'user')?.content.startsWith('I have cancelled this clarification form'))}
                            onReply={prompt => {
                              const request = messages.slice(0, messageIndex).reverse().find(previous => previous.role === 'user');
                              (onFollowUp || onSendMessage)(prompt, msg.mode, request?.presentationFormat, request?.templateId);
                            }} />
                        ) : null;
                      })()}

                      {/* Presentation Progress Indicator while generating */}
                      {isGeneratingDeck && (
                        <div className="bobdeck-generating-indicator" role="status" aria-live="polite">
                          <div className="bobdeck-generating-header">
                            <span className="bobdeck-spinner" aria-hidden="true">📊</span>
                            <div>
                              <strong>{t("Creating your presentation…")}</strong>
                              <small>{t("Slides appear in Presentation Studio as they are written")}</small>
                            </div>
                          </div>
                          <div className="generating-progress-bar">
                            <div className="generating-progress-fill"></div>
                          </div>
                        </div>
                      )}

                      {!msg.presentationDeleted && (resolvedDeck || htmlDeckData || (bobdeckData as any)?.filename || isGeneratingDeck) && (
                        <button type="button" className="presentation-banner-btn" onClick={() => window.dispatchEvent(new CustomEvent('buddy-open-presentation', {
                          detail: { sessionId, path: htmlDeckData?.filename || (bobdeckData as any)?.filename, deck: resolvedDeck, html: htmlDeckData?.html, title: htmlDeckData?.title },
                        }))}>
                          {t("Open Presentation Studio")}</button>
                      )}

                      <div className="msg-actions" role="group" aria-label={t('Answer actions')}>
                        <AnswerContext compact answer={msg} request={requestForAnswer(messages, messageIndex)} progressSummary={explicitThoughts} />
                        {!msg.isStreaming && msg.content.trim() && <CopyButton compact className="msg-deck-btn answer-icon-action" text={msg.content} label="Copy answer" />}
                        {!readOnly && onDeleteMessage && sessionId && <button type="button" className="msg-deck-btn answer-icon-action answer-icon-action-danger" disabled={isStreaming || msg.isStreaming || deletingMessage} onClick={() => void onDeleteMessage(msg.id)}><AnswerActionLabel icon="delete" label={t('Delete answer')} /></button>}
                        {!readOnly && !isStreaming && !msg.isStreaming && msg.content.trim() && <ShareToPeopleButton compact className="msg-deck-btn answer-icon-action" item={{ kind: 'text', title: 'Assistant answer', body: msg.content }} />}
                        {!readOnly && !msg.isStreaming && !stickyNotes.notes.length && msg.content.trim().length > 20 && <button type="button" className="msg-deck-btn answer-icon-action" disabled={isStreaming} onClick={() => onSendMessage(`Make me sticky notes from this previous response. Preserve important details and source links.\n\n${msg.content}`, 'agent')}><AnswerActionLabel icon="notes" label={t('Make notes')} /></button>}
                        {!readOnly && sessionId && onBranch && !isStreaming && !msg.isStreaming && <button type="button" className="msg-deck-btn answer-icon-action" onClick={() => void onBranch(msg.historyTurnIndex ?? messages.slice(0, messageIndex + 1).filter(message => message.role === 'user').length - 1)}><AnswerActionLabel icon="branch" label={t('Branch conversation')} /></button>}
                        {!readOnly && !msg.isStreaming && msg.content.trim() && <button type="button" className="msg-deck-btn answer-icon-action" onClick={() => setReadRequest({text: msg.content, nonce: Date.now()})}><AnswerActionLabel icon="read" label={t('Read aloud')} /></button>}
                        {sessionId && !msg.isStreaming && msg.content.trim() && <AnswerFeedback compact key={`${sessionId}:${msg.id}`} sessionId={sessionId} answerIndex={msg.historyTurnIndex ?? messages.slice(0,messageIndex + 1).filter(message => message.role === 'assistant').length - 1} />}
                        {((msg.tokens && msg.tokens > 0) || (msg.cost && msg.cost > 0)) && (
                          <span className="answer-icon-action answer-usage" tabIndex={0}>
                            <AnswerActionLabel icon="usage" label={brandText(`${t('Buddy reported tokens and Bobcoins')}: ${msg.tokens ? formatTokens(msg.tokens) : ''}${msg.cost ? ` · ${formatBobcoins(msg.cost)}` : ''}`)} />
                          </span>
                        )}
                        {!msg.isStreaming && !resolvedDeck && onGenerateDeckFromMessage && msg.content.trim().length > 20 && (
                          <button
                            type="button"
                            className="msg-deck-btn answer-icon-action"
                            onClick={() => onGenerateDeckFromMessage(msg.content)}
                          >
                            <AnswerActionLabel icon="deck" label={t("Executive Deck")} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>
      </section>

      {/* COMPOSER */}
      {!readOnly && <footer className="composer-wrap">
        <div className="composer-tool-row" role="group" aria-label={t('Chat tools')}>
          <div className="composer-tool-shortcuts">{composerShortcuts}</div>
          <div className="composer-context-tools">{composerTools}</div>
          <div className="composer-tool-utilities">
            <button type="button" className={`composer-tool-shortcut${skillsOpen || messages.length === 0 ? ' is-active' : ''}`} aria-expanded={skillsOpen || messages.length === 0} aria-controls="chat-skill-picker" onClick={() => {
              if (!messages.length) document.querySelector<HTMLInputElement>('#chat-skill-picker input')?.focus();
              else setSkillsOpen(open => !open);
            }}>{talkToAgentsMode ? t('Agents') : t('Skills')}</button>
        <VoiceChat messages={messages} sessionId={sessionId} busy={isStreaming} disabled={isUploading || Boolean(attachedFile)} enabled={voiceEnabled}
          readRequest={readRequest} onActiveChange={setVoiceActive} onStop={onStop}
          onSend={text => selectedSkill ? onSendMessage(text, undefined, undefined, undefined, skillPayload) : (onVoiceSend || onSendMessage)(text)} />
          </div>
        </div>
        {messages.length > 0 && skillsOpen && <div id="chat-skill-picker" className="composer-skill-catalog">{renderPicker()}</div>}
        {selectedSkills.length > 0 && !talkToAgentsMode && <div className="composer-skill-summary" role="status" style={{flexWrap: 'wrap'}}>
          <span>{selectedSkills.length} / 6 {t('Skills')}</span>
          {selectedSkills.map(name => <button type="button" key={name} disabled={isStreaming || isUploading} aria-label={t('Remove {0}', [skillDisplayName(name)])} onClick={() => chooseSkill(name)}>{skillDisplayName(name)} ×</button>)}
          <button type="button" disabled={isStreaming || isUploading} onClick={() => chooseSkill('')}>{t('Clear skills')}</button>
        </div>}
        {attachedAgents.length > 0 && !activeAgent && <div className="composer-agent-chips" role="group" aria-label={t('Selected agents')}>
          {attachedAgents.map(slug => <button key={slug} type="button" className="chat-context-chip" disabled={isStreaming || isUploading} onClick={() => onChangeAttachedAgents?.(attachedAgents.filter(value => value !== slug))} aria-label={t('Remove agent {0}', [agents.find(agent => agent.slug === slug)?.name || slug])}><span>{t('Agent')}</span><strong>{agents.find(agent => agent.slug === slug)?.name || slug}</strong><span aria-hidden="true">×</span></button>)}
          <button type="button" className="chat-context-chip chat-context-chip-add" disabled={isStreaming || isUploading} onClick={() => setSkillsOpen(open => !open)}><span>+</span><strong>{t('Agents')}</strong></button>
        </div>}
        {composerReferences && <div className="composer-reference-tray">{composerReferences}</div>}
        {showSlash && !isStreaming && (
          <Toolbar menu className="slash-menu" id="skill-command-menu" ref={slashMenuRef}
            onKeyDown={(e) => {
              const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
              } else if (e.key === "Escape") {
                e.preventDefault(); setShowSlash(false); textareaRef.current?.focus();
              }
            }}>
            <div className="slash-menu-heading">{t("SKILLS · TYPE TO FILTER")}</div>
            {visibleSkills.length === 0 && <div className="slash-menu-heading">{t("No matching skills")}</div>}
            {visibleSkills.map((sk) => (
              <button
                key={sk.name}
                type="button"
                className="slash-option"
                onClick={() => {
                  setInput(`/${sk.name} `);
                  setShowSlash(false);
                  textareaRef.current?.focus();
                }}
              >
                <div>
                  <strong>{skillDisplayName(sk.name)}</strong>
                  <small>{t(sk.description)}</small>
                </div>
                <span className="slash-option-kind">{t("SKILL")}</span>
              </button>
            ))}

            <div className="slash-menu-heading">{t("MODES")}</div>
            {visibleModes.map((m) => (
              <button
                key={m.slug}
                type="button"
                className="slash-option"
                onClick={() => {
                  setInput(`/mode ${m.slug} `);
                  setShowSlash(false);
                  textareaRef.current?.focus();
                }}
              >
                <div>
                  <strong>{"/mode"}{m.slug}</strong>
                  <small>{t(m.description)}</small>
                </div>
                <span className="slash-option-kind">{t("MODE")}</span>
              </button>
            ))}

            <div className="slash-menu-heading">{t("A2A AGENTS")}</div>
            {visibleAgents.map((ag) => (
              <button
                key={ag.slug}
                type="button"
                className="slash-option"
                onClick={() => {
                  setInput(`/agent ${ag.slug} `);
                  setShowSlash(false);
                  textareaRef.current?.focus();
                }}
              >
                <div>
                  <strong>{"/agent"}{ag.slug}</strong>
                  <small>{ag.description || ag.endpoint}</small>
                </div>
                <span className="slash-option-kind">A2A</span>
              </button>
            ))}

            {visibleModCommands.length > 0 && (
              <>
                <div className="slash-menu-heading">{t("WORKSPACE & EXTENSIONS")}</div>
                {visibleModCommands.map((cmd) => (
                  <button
                    key={cmd.command}
                    type="button"
                    className="slash-option"
                    onClick={() => {
                      setInput(`${cmd.command} `);
                      setShowSlash(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <div>
                      <strong>{cmd.command}</strong>
                      <small>{t(cmd.description)}</small>
                    </div>
                    <span className="slash-option-kind" style={{ color: themeCssValue('#9333ea') }}>{cmd.command === '/preview' ? 'STUDIO' : 'MOD'}</span>
                  </button>
                ))}
              </>
            )}
          </Toolbar>
        )}

        <span className="sr-only" role="status">
          {isSavingFiles ? t("Your answer is ready. Saving files…") : isStreaming ? guidanceEnabled ? t("Generating response. Send guidance to steer Buddy, or stop generation.") : t("Generating response. Use Stop generation to cancel.") : ''}
        </span>


        <form
          className={`composer ${isDragging ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            accept=".csv,.xlsx,.xls,.tsv,.txt,.json,.parquet,.html,.htm,.pdf,.docx,.md"
            style={{ display: 'none' }}
            id="chat-file-input"
          />

          <Toolbar className="composer-header">
            <label className="sr-only" htmlFor="prompt-input">
              {guidanceEnabled ? t("Guide this response") : activeAgentObj ? `Message ${activeAgentObj.name}` : t("Message Buddy")}
            </label>
            <div className="composer-header-actions">
              {!talkToAgentsMode && <label className="composer-skill-picker">
                <span>{t("Skill")}</span>
                <select
                  aria-label={t("Select skill")}
                  value=""
                  disabled={isStreaming || isUploading || skills.length === 0}
                  onChange={(event) => {
                    chooseSkill(event.target.value);
                  }}
                >
                  <option value="">{selectedSkills.length ? `${selectedSkills.length} / 6 ${t("Skills")}` : t("Add skill")}</option>
                  {[...skills].sort((a, b) => a.name.localeCompare(b.name)).map(skill => (
                    <option key={skill.name} value={skill.name} disabled={selectedSkills.length >= 6 && !selectedSkills.includes(skill.name)}>{selectedSkills.includes(skill.name) ? "✓ " : ""}{skillDisplayName(skill.name)}</option>
                  ))}
                </select>
              </label>}
              <button
                className="slash-button"
                type="button"
                disabled={isStreaming}
                onClick={() => { setShowSlash(!showSlash); textareaRef.current?.focus(); }}
                title={t("Slash commands (/)")}
              >
                /
              </button>
              <button
                type="button"
                className={`composer-websearch-btn ${webSearchActive ? 'active' : ''}`}
                disabled={isStreaming || !webSearchReady || !hasWebSearchSkill || Boolean(activeAgent)}
                onClick={() => setWebSearchActive((prev) => !prev)}
                title={!webSearchReady ? t("Configure BRAVE_API_KEY to enable web search") : webSearchActive ? t("Web search enabled (Brave Search) - click to toggle off") : t("Enable Web Search (Brave Search)")}
                aria-pressed={webSearchActive}
              >
                <span className="websearch-btn-icon">🌐</span>
                <span className="websearch-btn-label">{t("Web Search")}</span>
                {webSearchActive && <span className="websearch-btn-badge">{t("ON")}</span>}
              </button>
              <VoiceInput key={sessionId} disabled={isStreaming || isUploading || voiceActive}
                onTranscript={text => setInput(previous => previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text)} />
              <button
                type="button"
                className="composer-shortcuts-btn"
                onClick={() => setIsShortcutsOpen(true)}
 title={t("View keyboard shortcuts (⌘/)")} aria-label={t("View keyboard shortcuts")} ><span>⌨️</span>
              </button>
            </div>
          </Toolbar>

          {uploadError && (
            <div className="composer-upload-error" role="alert">
              <span>⚠️ {uploadError}</span>
              <button type="button" onClick={() => setUploadError(null)} title={t("Dismiss")}>✕</button>
            </div>
          )}

          {isUploading && <div className="attached-chip upload-pending" role="status" aria-busy="true"><span className="upload-complete-mark" data-preparing="true" aria-hidden="true">↑</span><strong>{uploadName}</strong><span>{t('Uploading file…')}</span></div>}
          {attachedFile && !isUploading && (
            <div className="attached-chip" key={attachedFile.path}>
              <span className="upload-complete-mark" data-preparing={attachedFile.document && attachedFile.document.status !== 'ready' ? 'true' : undefined} role="status" aria-label={t(attachedFile.document && attachedFile.document.status !== 'ready' ? attachedFile.document.status === 'failed' ? 'Preparation failed' : 'Preparing document…' : 'Ready')}>
                {attachedFile.document && attachedFile.document.status !== 'ready' ? attachedFile.document.status === 'failed' ? '!' : '⋯' : '✓'}
              </span>
              <div className="attached-chip-info">
                <span className="attached-chip-icon">{attachedFile.is_spreadsheet ? '📊' : '📄'}</span>
                <strong className="attached-chip-name">{attachedFile.filename}</strong>
                <span className="attached-chip-size">({(attachedFile.size / 1024).toFixed(1)} {t("KB)")}</span>
                {attachedFile.document && <span className="attached-chip-badge" role="status">{t(attachedFile.document.status === 'ready' ? 'Ready' : attachedFile.document.status === 'failed' ? 'Preparation failed' : 'Preparing document…')}</span>}
                {attachedFile.document && !['ready', 'failed'].includes(attachedFile.document.status) && <span>{t('You can send your message when the document is ready to read.')}</span>}
                {documentCheckError && <span role="status">{t(documentCheckError)}</span>}
                {attachedFile.document?.status === 'failed' && <span role="alert">{t(attachedFile.document.error || 'This document could not be prepared.')} <button type="button" disabled={documentRetrying} onClick={() => void retryDocumentPreparation()}>{t(documentRetrying ? 'Retrying…' : 'Retry preparation')}</button></span>}
                {onViewAttachment && attachedFile.document && <button type="button" onClick={() => onViewAttachment(attachedFile.path)}>{t("View document")}</button>}
                {attachedFile.summary?.total_rows !== undefined && (
                  <span className="attached-chip-badge">{attachedFile.summary.total_rows.toLocaleString(getLocale())} {t("rows")}</span>
                )}
                {attachedFile.summary?.sheets_count !== undefined && (
                  <span className="attached-chip-badge">{attachedFile.summary.sheets_count} {t("sheets")}</span>
                )}
              </div>
              <button
                type="button"
                className="attached-chip-remove"
                onClick={() => { documentRetryController.current?.abort(); setDocumentRetrying(false); setAttachedFile(null); }}
                title={t("Remove attached file")}
                aria-label={t("Remove attached file")}
              >
                ✕
              </button>
            </div>
          )}

          {quotes.length > 0 && <div className="composer-quotes" aria-label={t('Selected text')}>
            {quotes.map(quote => <div className="composer-quote" key={quote.id}>
              <div className="composer-quote-content"><span>{t('Selected text')}</span><blockquote>{quote.text}</blockquote></div>
              <button type="button" aria-label={t('Remove selected text')} title={t('Remove selected text')}
                onClick={() => { setQuotes(current => current.filter(item => item.id !== quote.id)); textareaRef.current?.focus({ preventScroll: true }); }}>×</button>
            </div>)}
          </div>}

          <div className="composer-row">
            <button
              type="button"
              className="composer-clip-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || isStreaming}
              title={isUploading ? t("Uploading file…") : t("Attach document or data file")}
              aria-label={t("Attach document or data file")}
            >
              {isUploading ? (
                <span className="step-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden="true" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </button>
            <textarea
              ref={textareaRef}
              id="prompt-input"
              aria-label={guidanceEnabled ? t("Guide this response") : t("Message")}
              aria-describedby={guidanceStatus ? "guidance-status" : undefined}
              disabled={isUploading || guidancePending || (isStreaming && !guidanceEnabled)}
              aria-expanded={showSlash}
              aria-controls={showSlash ? "skill-command-menu" : undefined}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={
                guidanceEnabled
                  ? t("Guide this response…")
                  : isStreaming
                    ? t("Waiting for this response…")
                    : quotes.length > 0
                      ? t('Ask a question about the selected text…')
                    : webSearchActive
                  ? t("Search the live web with Brave…")
                  : activeAgentObj
                  ? `Message ${activeAgentObj.name}…`
                  : selectedSkill
                    ? t('Ask {0} a question…', [skillDisplayName(selectedSkill)])
                  : activeMode === 'presentation'
                    ? t("Describe the presentation you would like Buddy to build…")
                    : t("Message Buddy…")
              }
            />
            {guidanceEnabled && (
              <button
                type="submit"
                className="guidance-send-button"
                disabled={guidancePending || isUploading || !input.trim()}
                aria-label={t("Send guidance")}
                aria-busy={guidancePending}
                title={t("Send guidance to the ongoing response")}
              >
                {guidancePending && <span className="step-spinner" aria-hidden="true" />}
                <span>{guidancePending ? t("Sending…") : t("Send guidance")}</span>
              </button>
            )}
            {isStreaming ? (
              <button
                type="button"
                className="send-button stop-button"
                onClick={onStop}
                disabled={isSavingFiles}
                title={isSavingFiles ? t("Saving files") : t("Stop generation")}
                aria-label={isSavingFiles ? t("Saving files") : t("Stop generation")}
              >
                ■
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={isUploading || documentPending || (!input.trim() && !attachedFile)}
                title={t("Send message")}
              >
                ↑
              </button>
            )}
          </div>
          {guidanceStatus && (
            <div id="guidance-status" className={`guidance-status${guidanceStatus.error ? ' error' : ''}`}
              role={guidanceStatus.error ? 'alert' : 'status'}>
              {guidanceStatus.text}
            </div>
          )}
        </form>
      </footer>}

      {showScrollBottom && (
        <button
          type="button"
          className={`scroll-bottom-btn ${isStreaming ? 'is-streaming' : ''}`}
          onClick={() => scrollToBottom(false)}
          title={isStreaming ? t("Buddy is responding · Click to jump to latest") : t("Scroll to latest messages")}
        >
          {isStreaming ? (
            <>
              <span className="scroll-pulse-dot" aria-hidden="true" />
              <span>{t("New output ↓")}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true">↓</span>
              <span>{t("Latest")}</span>
            </>
          )}
        </button>
      )}

      <ShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />


    </div>
  );
};
