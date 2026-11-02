/**
 * Buddy Mods System - Types and Interfaces
 * Extensible modular plugin system for Buddy ACP.
 */

import type React from 'react';
import type { ChatMessage, WorkspacePage } from '../types';
import type { LivePresentationArtifact } from '../lib/presentationFiles';

export interface BobModCommand {
  command: string; // e.g. '/preview'
  description: string;
  usage?: string;
  handler?: (context: BobModContext) => void | boolean;
}

export interface BobModContext {
  sessionId: string;
  isStreaming: boolean;
  messages: ChatMessage[];
  pages: WorkspacePage[];
  files: Array<{ name: string; size: number }>;
  activeMode: string;
  liveArtifact?: LivePresentationArtifact;
  presentationPath?: string;
}

export interface BobModPanelProps {
  sessionId: string;
  isStreaming: boolean;
  messages: ChatMessage[];
  pages: WorkspacePage[];
  files: Array<{ name: string; size: number }>;
  activeMode: string;
  liveArtifact?: LivePresentationArtifact;
  presentationPath?: string;
  onClose: () => void;
  onRefreshPages?: () => void;
  onOpenFullscreen?: (page: WorkspacePage) => void;
}

export type BobModCategory = 'ui' | 'productivity' | 'tools';

export interface BobMod {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  category: BobModCategory;
  author: string;
  defaultEnabled: boolean;
  commands?: BobModCommand[];
  features?: string[];
  renderPanel?: (props: BobModPanelProps) => React.ReactNode;
  isPanelAvailable?: (context: BobModContext) => boolean;
}
