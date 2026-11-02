// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import mermaid from 'mermaid';

import { structuredMermaid } from '../../document-export';
import {
  defaultTemplateDesign,
  templateDesignError,
  createTemplatePreviewDeck,
  createTemplateHtml,
  type TemplateDesign,
} from '../../src/lib/templateDesign';
import { parseNoteRevision, enrichNote } from '../../src/lib/noteEnrichment';
import { loadPortfolioBobContext, preparePortfolioBobContext } from '../../src/lib/portfolioBob';
import { reconcileMarkdownNode } from '../../src/lib/reconcileMarkdown';
import {
  parseSharedConversation,
  isNotesPath,
  isProjectsPath,
  updateConversationUrl,
  navigateNotes,
  navigateProjects,
} from '../../src/lib/conversationUrl';
import { startInterfaceMotion } from '../../src/lib/interfaceMotion';
import { trackVisibleViewport } from '../../src/lib/viewport';
import {
  useAppRegistry,
  workspaceAppGroups,
  workspaceAppGroup,
  type WorkspaceApp,
} from '../../src/lib/appRegistry';
import {
  deliveryStates,
  applyDeliveryStep,
  applyDeliveryEvent,
  localDeliveryStep,
  type RequestDelivery,
} from '../../src/lib/requestDelivery';
import {
  sourceMetadata,
  attachSourceMetadata,
  sourcePopupPosition,
} from '../../src/lib/sourcePreview';
import {
  groupMissedCalls,
  missedCallColors,
  type MissedCall,
} from '../../src/lib/missedCalls';
import type { DiagramSpec } from '../../src/lib/structuredDiagram';

describe('Tier 1 Frontend Pure Logic & Lib Utilities', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    // Setup DOM elements for document export
    document.body.innerHTML = '<h1 id="document-title"></h1><div id="document-body"></div>';

    // Mock document.fonts
    if (!('fonts' in document)) {
      Object.defineProperty(document, 'fonts', {
        value: { ready: Promise.resolve() },
        configurable: true,
      });
    }

    // Mock SVGSVGElement.prototype.viewBox for jsdom
    if (typeof window !== 'undefined' && window.SVGSVGElement) {
      Object.defineProperty(window.SVGSVGElement.prototype, 'viewBox', {
        get() {
          const vb = this.getAttribute('viewBox') || '0 0 100 100';
          const parts = vb.trim().split(/\s+/).map(Number);
          return {
            baseVal: {
              x: parts[0] || 0,
              y: parts[1] || 0,
              width: parts[2] || 100,
              height: parts[3] || 100,
            },
          };
        },
        configurable: true,
      });
    }

    // Mock matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    // Mock getClientRects
    window.HTMLElement.prototype.getClientRects = vi.fn().mockReturnValue([
      { x: 0, y: 0, width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0 },
    ] as unknown as DOMRectList);

    // Mock Element.prototype.animate
    if (!Element.prototype.animate) {
      Element.prototype.animate = vi.fn().mockImplementation(() => {
        let cancelled = false;
        return {
          playState: 'running',
          finished: new Promise<void>((resolve, reject) => {
            setTimeout(() => (cancelled ? reject(new Error('cancelled')) : resolve()), 0);
          }),
          cancel: vi.fn().mockImplementation(() => { cancelled = true; }),
          finish: vi.fn(),
        };
      });
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. document-export.ts
  // =========================================================================
  describe('document-export.ts', () => {
    it('structuredMermaid converts sequence diagram specs with proper participant aliases and message escaping', () => {
      const spec: DiagramSpec = {
        title: 'Sequence Flow',
        kind: 'sequence',
        direction: 'LR',
        nodes: [
          { id: 'client', label: 'Web <Client> & App' },
          { id: 'server', label: 'Backend "API" ; Service' },
        ],
        edges: [
          { source: 'client', target: 'server', label: 'POST /data | stream' },
          { source: 'server', target: 'client' }, // No label, defaults to 'Message'
        ],
      };

      const result = structuredMermaid(spec);
      expect(result).toContain('sequenceDiagram');
      expect(result).toContain('participant N0 as Web #60;Client#62; #38; App');
      expect(result).toContain('participant N1 as Backend #34;API#34; #59; Service');
      expect(result).toContain('N0->>N1: POST /data #124; stream');
      expect(result).toContain('N1->>N0: Message');
    });

    it('structuredMermaid converts flowchart diagram specs with lanes, node shapes, and direction', () => {
      const spec: DiagramSpec = {
        title: 'Architecture Overview',
        kind: 'flowchart',
        direction: 'TB',
        lanes: [
          { id: 'lane1', label: 'Ingestion \\ Lane' },
        ],
        nodes: [
          { id: 'n1', label: 'Start', shape: 'rounded', lane: 'lane1' },
          { id: 'n2', label: 'Decision', shape: 'diamond', lane: 'lane1' },
          { id: 'n3', label: 'Store', shape: 'database' },
          { id: 'n4', label: 'Service', shape: 'rectangle' },
          { id: 'n5', label: 'Terminal', shape: 'ellipse' },
        ],
        edges: [
          { source: 'n1', target: 'n2', label: 'Step 1' },
          { source: 'n2', target: 'n3' }, // Unlabeled edge
          { source: 'n3', target: 'n4' },
          { source: 'n4', target: 'n5' },
        ],
      };

      const result = structuredMermaid(spec);
      expect(result).toContain('flowchart TD');
      expect(result).toContain('subgraph L0 ["Ingestion #92; Lane"]');
      expect(result).toContain('N0("Start")');
      expect(result).toContain('N1{"Decision"}');
      expect(result).toContain('N2[("Store")]');
      expect(result).toContain('N3["Service"]');
      expect(result).toContain('N4(["Terminal"])');
      expect(result).toContain('N0 -->|"Step 1"| N1');
      expect(result).toContain('N1 --> N2');
    });

    it('BuddyDocumentExport.prepare exports document with headings, lists, tables, and warnings', async () => {
      const exportHelper = (window as unknown as { BuddyDocumentExport?: { prepare: (title: string, body: string) => Promise<{ blocks: unknown[]; warnings: string[] }> } }).BuddyDocumentExport;
      expect(exportHelper).toBeDefined();

      // Mock mermaid.render
      vi.spyOn(mermaid, 'render').mockResolvedValue({
        svg: '<svg viewBox="0 0 400 300"><rect x="0" y="0" width="100" height="100" /><text>Sample</text></svg>',
        diagramType: 'flowchart',
      });

      const markdown = `
# Title Heading
## Subtitle Heading
### Section Heading

A regular paragraph with **bold** and *italic* and \`inline code\` and a [safe link](https://example.com) and an [unsafe link](javascript:alert(1)).

![Image description](https://example.com/pic.png)

> A blockquote paragraph

- Unordered item 1
  - Nested item 1
- Unordered item 2

1. Ordered item 1
2. Ordered item 2

---

| Col A | Col B |
| :--- | :--- |
| Val 1 | Val 2 |

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
      `;

      const result = await exportHelper!.prepare('Document Test', markdown);
      expect(result).toBeDefined();
      expect(result.blocks.length).toBeGreaterThan(0);

      // Verify title set on DOM
      expect(document.getElementById('document-title')?.textContent).toBe('Document Test');

      // Verify block types
      const types = (result.blocks as { type: string }[]).map(b => b.type);
      expect(types).toContain('heading');
      expect(types).toContain('paragraph');
      expect(types).toContain('table');
      expect(types).toContain('image');
    });

    it('BuddyDocumentExport.prepare handles bobdiagram code blocks with valid and invalid specs', async () => {
      const exportHelper = (window as unknown as { BuddyDocumentExport?: { prepare: (title: string, body: string) => Promise<{ blocks: unknown[]; warnings: string[] }> } }).BuddyDocumentExport;

      vi.spyOn(mermaid, 'render').mockResolvedValue({
        svg: '<svg viewBox="0 0 1200 1400"><rect width="10" height="10" /><text>Bob</text></svg>',
        diagramType: 'flowchart',
      });

      const validBobDiagram = JSON.stringify({
        id: 'diag1',
        kind: 'flow',
        title: 'Structured System Diagram',
        direction: 'LR',
        lanes: [{ id: 'lane1', label: 'Primary Lane' }],
        nodes: [
          { id: 'a', label: 'App', shape: 'rectangle', lane: 'lane1' },
          { id: 'b', label: 'DB', shape: 'database' },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: 'connect' }],
      });

      const markdown = `
\`\`\`bobdiagram
${validBobDiagram}
\`\`\`

\`\`\`bobdiagram
{ invalid json syntax
\`\`\`
      `;

      const result = await exportHelper!.prepare('Bob Diagram Test', markdown);
      expect(result.warnings).toContain('Diagram could not be rendered (invalid structured diagram). Source follows.');
    });

    it('BuddyDocumentExport.prepare rejects unsupported diagram directives and limits', async () => {
      const exportHelper = (window as unknown as { BuddyDocumentExport?: { prepare: (title: string, body: string) => Promise<{ blocks: unknown[]; warnings: string[] }> } }).BuddyDocumentExport;

      const markdown = `
\`\`\`mermaid
flowchart LR
  click Node1 "http://bad.link"
\`\`\`

\`\`\`mermaid
accTitle: An Accessible Title
flowchart LR
  A --> B
\`\`\`

\`\`\`mermaid
flowchart LR
  %%{init: {"theme": "forest"}}%%
  A --> B
\`\`\`

\`\`\`mermaid
---
title: Yaml Frontmatter
---
flowchart LR
  A --> B
\`\`\`
      `;

      const result = await exportHelper!.prepare('Directives Test', markdown);
      expect(result.warnings.some(w => w.includes('unsupported diagram directives'))).toBe(true);
    });

    it('BuddyDocumentExport.prepare handles SVG with foreignObject, empty SVG, and wide tables', async () => {
      const exportHelper = (window as unknown as { BuddyDocumentExport?: { prepare: (title: string, body: string) => Promise<{ blocks: unknown[]; warnings: string[] }> } }).BuddyDocumentExport;

      // 1. Test foreignObject rejection
      vi.spyOn(mermaid, 'render').mockResolvedValueOnce({
        svg: '<svg viewBox="0 0 100 100"><foreignObject>HTML label</foreignObject></svg>',
        diagramType: 'flowchart',
      });

      const md1 = '```mermaid\nflowchart LR\nA --> B\n```';
      const res1 = await exportHelper!.prepare('ForeignObject Test', md1);
      expect(res1.warnings.some(w => w.includes('invalid or unsupported diagram'))).toBe(true);

      // 2. Test empty SVG (no elements)
      vi.spyOn(mermaid, 'render').mockResolvedValueOnce({
        svg: '<svg viewBox="0 0 100 100"></svg>',
        diagramType: 'flowchart',
      });
      const res2 = await exportHelper!.prepare('Empty SVG Test', md1);
      expect(res2.warnings.some(w => w.includes('invalid or unsupported diagram'))).toBe(true);

      // 3. Test table splitting (table with 10 columns)
      const wideTableMd = `
| C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| A1 | A2 | A3 | A4 | A5 | A6 | A7 | A8 | A9 | A10 |
| B1 | B2 | B3 | B4 | B5 | B6 | B7 | B8 | B9 | B10 |
      `;
      const res3 = await exportHelper!.prepare('Wide Table Test', wideTableMd);
      expect(res3.blocks.some((b: any) => b.type === 'paragraph' && b.runs?.some((r: any) => r.text?.includes('Wide table')))).toBe(true);

      // 4. Test table exceeding limit (>64 columns)
      const cols = Array.from({ length: 70 }, (_, i) => `Col${i}`).join(' | ');
      const seps = Array.from({ length: 70 }, () => '---').join(' | ');
      const vals = Array.from({ length: 70 }, (_, i) => `Val${i}`).join(' | ');
      const hugeTableMd = `| ${cols} |\n| ${seps} |\n| ${vals} |`;
      const res4 = await exportHelper!.prepare('Huge Table Test', hugeTableMd);
      expect(res4.blocks.some((b: any) => b.type === 'code' && b.runs?.some((r: any) => r.text?.includes('Col0')))).toBe(true);
    });
  });

  // =========================================================================
  // 2. templateDesign.ts
  // =========================================================================
  describe('templateDesign.ts', () => {
    it('validates defaultTemplateDesign and reports no error', () => {
      expect(defaultTemplateDesign.title).toBe('My presentation template');
      expect(defaultTemplateDesign.brand).toBe('My brand');
      expect(templateDesignError(defaultTemplateDesign)).toBe('');
    });

    it('templateDesignError checks title, brand, length, newlines, fonts, colors, and layout', () => {
      const copy = (): TemplateDesign => JSON.parse(JSON.stringify(defaultTemplateDesign));

      // Blank title
      let d = copy();
      d.title = '   ';
      expect(templateDesignError(d)).toBe('Enter a template name.');

      // Blank brand
      d = copy();
      d.brand = '';
      expect(templateDesignError(d)).toBe('Enter a brand name.');

      // Title too long
      d = copy();
      d.title = 'A'.repeat(101);
      expect(templateDesignError(d)).toBe('Names must be 100 characters or fewer.');

      // Multi-line title
      d = copy();
      d.title = 'Title\nWith\nNewlines';
      expect(templateDesignError(d)).toBe('Names must fit on one line.');

      // Invalid font
      d = copy();
      d.fonts.heading = 'Bad<Font>';
      expect(templateDesignError(d)).toBe('Choose a valid font name.');

      // Invalid color (not 6-digit hex)
      d = copy();
      d.colors.primary = '#1234';
      expect(templateDesignError(d)).toBe('Use a six-digit hex value for every color, for example #5627A7.');

      // Invalid layout
      d = copy();
      (d.design as any).contentLayout = 'unsupported';
      expect(templateDesignError(d)).toBe('Choose a supported layout and chart style.');

      // Invalid transition
      d = copy();
      (d.design as any).htmlTransition = 'flip';
      expect(templateDesignError(d)).toBe('Choose a supported HTML transition.');
    });

    it('createTemplatePreviewDeck creates slides for cards, comparison, timeline layouts and chart styles', () => {
      const designCards = { ...defaultTemplateDesign };
      const deckCards = createTemplatePreviewDeck(designCards);
      expect(deckCards.title).toBe(defaultTemplateDesign.title);
      expect(deckCards.slides.length).toBe(3); // hero, content, closing

      // Comparison layout
      const designComparison: TemplateDesign = {
        ...defaultTemplateDesign,
        design: { ...defaultTemplateDesign.design, contentLayout: 'comparison', decoration: 'topbar' },
      };
      const deckComp = createTemplatePreviewDeck(designComparison);
      const compSlide = deckComp.slides.find(s => s.id === 'content');
      expect(compSlide?.elements.some(e => (e as any).text === 'Option A')).toBe(true);

      // Timeline layout with chart
      const designTimeline: TemplateDesign = {
        ...defaultTemplateDesign,
        design: { ...defaultTemplateDesign.design, contentLayout: 'timeline', chartType: 'bar', decoration: 'none' },
      };
      const deckTimeline = createTemplatePreviewDeck(designTimeline);
      expect(deckTimeline.slides.some(s => s.id === 'chart')).toBe(true);
      const timelineSlide = deckTimeline.slides.find(s => s.id === 'content');
      expect(timelineSlide?.elements.some(e => (e as any).text === 'Stage 1')).toBe(true);
    });

    it('createTemplateHtml generates HTML with controls, navigation script, and escaping', () => {
      const design = { ...defaultTemplateDesign };
      const slides = ['<svg><text>Slide 1</text></svg>', '<svg><text>Slide 2</text></svg>'];

      const html = createTemplateHtml(design, slides, { language: 'en' });
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('<button id="previous"');
      expect(html).toContain('<button id="next"');
      expect(html).toContain('templateFade');

      // Without navigation
      const designNoNav: TemplateDesign = {
        ...defaultTemplateDesign,
        design: { ...defaultTemplateDesign.design, htmlNavigation: false, htmlTransition: 'slide' },
      };
      const htmlNoNav = createTemplateHtml(designNoNav, slides);
      expect(htmlNoNav).not.toContain('<nav aria-label=');
      expect(htmlNoNav).toContain('templateSlide');
    });
  });

  // =========================================================================
  // 3. noteEnrichment.ts
  // =========================================================================
  describe('noteEnrichment.ts', () => {
    it('parseNoteRevision parses JSON note revisions with optional fences', () => {
      const json = JSON.stringify({ title: 'Reviewed Title', body: 'Enriched note body text.' });
      expect(parseNoteRevision(json)).toEqual({ title: 'Reviewed Title', body: 'Enriched note body text.' });

      const fenced = '```json\n' + json + '\n```';
      expect(parseNoteRevision(fenced)).toEqual({ title: 'Reviewed Title', body: 'Enriched note body text.' });

      const plainFence = '```\n' + json + '\n```';
      expect(parseNoteRevision(plainFence)).toEqual({ title: 'Reviewed Title', body: 'Enriched note body text.' });
    });

    it('parseNoteRevision throws on malformed or schema-violating note revisions', () => {
      expect(() => parseNoteRevision('not json')).toThrow('The note update did not return valid JSON');
      expect(() => parseNoteRevision(JSON.stringify(['an', 'array']))).toThrow('The note update must contain a title');
      expect(() => parseNoteRevision(JSON.stringify({ title: '', body: 'Valid' }))).toThrow('The note update must contain a title');
      expect(() => parseNoteRevision(JSON.stringify({ title: 'Valid', body: '' }))).toThrow('The note update must contain a title');
      expect(() => parseNoteRevision(JSON.stringify({ title: 'T'.repeat(161), body: 'Valid' }))).toThrow('The note update must contain a title');
      expect(() => parseNoteRevision(JSON.stringify({ title: 'Valid', body: 'B'.repeat(6001) }))).toThrow('The note update must contain a title');
      expect(() => parseNoteRevision(JSON.stringify({ title: 'Valid', body: 'Valid', unknownKey: 123 }))).toThrow('The note update must contain a title');
    });

    it('enrichNote rejects invalid instruction lengths or aborted signals early', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(enrichNote({ title: 'T', body: 'B' }, 'instruction', { signal: controller.signal }))
        .rejects.toThrow();

      const liveController = new AbortController();
      await expect(enrichNote({ title: 'T', body: 'B' }, '   ', { signal: liveController.signal }))
        .rejects.toThrow('Enter an instruction of up to 4000 characters.');

      await expect(enrichNote({ title: 'T', body: 'B' }, 'X'.repeat(4001), { signal: liveController.signal }))
        .rejects.toThrow('Enter an instruction of up to 4000 characters.');
    });

    it('enrichNote coordinates workspace creation, chat submission, and streaming response', async () => {
      const onStatus = vi.fn();
      const controller = new AbortController();

      // Mock fetch
      const globalFetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/notes/workspace') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: 'workspace-999' }),
          });
        }
        if (url === '/chat/stream') {
          const events = [
            JSON.stringify({ type: 'status', message: 'Analyzing sources…' }) + '\n',
            JSON.stringify({ type: 'tool' }) + '\n',
            JSON.stringify({ type: 'delta', text: '{"title":"Updated Note",' }) + '\n',
            JSON.stringify({ type: 'delta', text: '"body":"Complete body content."}' }) + '\n',
            JSON.stringify({ type: 'done' }) + '\n',
          ];
          const stream = new ReadableStream({
            start(controllerStream) {
              const encoder = new TextEncoder();
              for (const ev of events) {
                controllerStream.enqueue(encoder.encode(ev));
              }
              controllerStream.close();
            },
          });
          return Promise.resolve(new Response(stream, { status: 200, headers: { 'X-Bob-Job-Id': 'job-42' } }));
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      });
      vi.stubGlobal('fetch', globalFetch);

      const result = await enrichNote(
        { title: 'Draft Note', body: 'Initial draft.' },
        'Add detail and references',
        { signal: controller.signal, onStatus },
      );

      expect(result).toEqual({ title: 'Updated Note', body: 'Complete body content.' });
      expect(onStatus).toHaveBeenCalledWith('Analyzing sources…');
      expect(onStatus).toHaveBeenCalledWith('Working on your note…');
    });

    it('enrichNote throws when server stream reports an error or pending approval', async () => {
      const controller = new AbortController();

      const globalFetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/notes/workspace') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'ws-1' }) });
        }
        if (url === '/chat/stream') {
          const events = [
            JSON.stringify({ type: 'approval', status: 'pending' }) + '\n',
          ];
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(events[0]));
              c.close();
            },
          });
          return Promise.resolve(new Response(stream, { status: 200 }));
        }
        return Promise.reject(new Error(url));
      });
      vi.stubGlobal('fetch', globalFetch);

      await expect(enrichNote({ title: 'T', body: 'B' }, 'Run command', { signal: controller.signal }))
        .rejects.toThrow('action requiring approval');
    });

    it('enrichNote formats validation issues and supports delta replacement', async () => {
      const controller = new AbortController();

      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url === '/api/notes/workspace') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'ws-1' }) });
        if (url === '/chat/stream') {
          return Promise.resolve(new Response(JSON.stringify({
            detail: [{ loc: ['body', 'prompt'], msg: 'Prompt too long' }],
          }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.reject(new Error(url));
      }));

      await expect(enrichNote({ title: 'T', body: 'B' }, 'instruction', { signal: controller.signal }))
        .rejects.toThrow('Could not update the note: prompt: Prompt too long');
    });
  });

  // =========================================================================
  // 4. portfolioBob.ts
  // =========================================================================
  describe('portfolioBob.ts', () => {
    it('loadPortfolioBobContext fetches context, filters selections and validates relationships', async () => {
      const mockPortfolio = {
        projects: [
          { id: 'proj-1', name: 'Alpha Project' },
          { id: 'proj-2', name: 'Beta Project' },
        ],
        people: [
          { id: 'person-1', name: 'Alice Specialist' },
        ],
        work_items: [
          { id: 'work-1', project_id: 'proj-1', title: 'Task 1' },
        ],
        assignments: [
          { id: 'assign-1', project_id: 'proj-1', person_id: 'person-1' },
        ],
        dependencies: [
          { id: 'dep-1', source_project_id: 'proj-1', target_project_id: 'proj-2' },
        ],
      };

      const globalFetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/projects/context') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ portfolio: mockPortfolio, instructions: 'Follow PRINCE2' }),
          });
        }
        if (url === '/api/projects/impact/preview') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ affected_projects: ['proj-1'] }),
          });
        }
        return Promise.reject(new Error(`Unexpected ${url}`));
      });
      vi.stubGlobal('fetch', globalFetch);

      const serialized = await loadPortfolioBobContext({
        source: 'overview',
        projectId: 'proj-1',
        personId: 'person-1',
        workItemId: 'work-1',
        assignmentId: 'assign-1',
        dependencyId: 'dep-1',
        scenario: { kind: 'person_departure', person_id: 'person-1', departure_date: '2026-12-31' },
      });

      expect(serialized).toBeDefined();
      const parsed = JSON.parse(serialized);
      expect(parsed.focus.project.id).toBe('proj-1');
      expect(parsed.focus.person.id).toBe('person-1');
      expect(parsed.focus.work_item.id).toBe('work-1');
      expect(parsed.focus.assignment.id).toBe('assign-1');
      expect(parsed.focus.dependency.id).toBe('dep-1');
      expect(parsed.scenario.impact.affected_projects).toEqual(['proj-1']);
    });

    it('loadPortfolioBobContext throws on foreign cross-project references and invalid scenarios', async () => {
      const mockPortfolio = {
        projects: [{ id: 'proj-1' }, { id: 'proj-2' }],
        people: [{ id: 'person-1' }],
        work_items: [{ id: 'work-alien', project_id: 'proj-2' }],
        assignments: [],
        dependencies: [{ id: 'dep-foreign', source_project_id: 'proj-3', target_project_id: 'proj-4' }],
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ portfolio: mockPortfolio }),
      }));

      // Work item from another project
      await expect(loadPortfolioBobContext({ source: 'test', projectId: 'proj-1', workItemId: 'work-alien' }))
        .rejects.toThrow('The selected item belongs to another project.');

      // Dependency from another project
      await expect(loadPortfolioBobContext({ source: 'test', projectId: 'proj-1', dependencyId: 'dep-foreign' }))
        .rejects.toThrow('The selected dependency does not belong to this project.');

      // Invalid scenario kind
      await expect(loadPortfolioBobContext({ source: 'test', scenario: { kind: 'unknown_kind' } }))
        .rejects.toThrow('Select a valid change to discuss with Bob.');
    });

    it('preparePortfolioBobContext uses cached projects or resolves fresh projects list', async () => {
      const mockPortfolio = { projects: [{ id: 'p1' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ portfolio: mockPortfolio }),
      }));

      // With existing projects
      const existing = [{ id: 'p1', name: 'Cached' }];
      const fetcher = vi.fn();
      const res1 = await preparePortfolioBobContext({ source: 'cached' }, existing, fetcher);
      expect(res1.projects).toBe(existing);
      expect(fetcher).not.toHaveBeenCalled();

      // Without existing projects
      const fetcher2 = vi.fn().mockResolvedValue([{ id: 'p1', name: 'Fetched' }]);
      const res2 = await preparePortfolioBobContext({ source: 'fresh' }, [], fetcher2);
      expect(res2.projects).toEqual([{ id: 'p1', name: 'Fetched' }]);
      expect(fetcher2).toHaveBeenCalled();
    });

    it('loadPortfolioBobContext handles project_change scenarios and server errors', async () => {
      const mockPortfolio = {
        projects: [{ id: 'proj-1', name: 'Alpha Project' }],
        people: [],
        work_items: [],
        assignments: [],
        dependencies: [],
      };

      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url === '/api/projects/context') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ portfolio: mockPortfolio, instructions: 'PRINCE2' }),
          });
        }
        if (url === '/api/projects/impact/preview') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ impact_summary: 'Schedule delayed by 5 days' }),
          });
        }
        return Promise.reject(new Error(url));
      }));

      const res = await loadPortfolioBobContext({
        source: 'test',
        projectId: 'proj-1',
        scenario: { kind: 'project_change', project_id: 'proj-1', due_date: '2026-12-31', start_date: '2026-06-01', status: 'paused' },
      });
      const parsed = JSON.parse(res);
      expect(parsed.scenario.change.kind).toBe('project_change');
      expect(parsed.scenario.change.due_date).toBe('2026-12-31');
      expect(parsed.scenario.change.start_date).toBe('2026-06-01');
      expect(parsed.scenario.change.status).toBe('paused');

      // Server error handling
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ detail: 'Access forbidden for project' }),
      }));
      await expect(loadPortfolioBobContext({ source: 'test' }))
        .rejects.toThrow('Access forbidden for project');

      // Fetch projects fallback on reject
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ portfolio: mockPortfolio, instructions: 'PRINCE2' }),
      }));
      const rejectingFetcher = vi.fn().mockRejectedValue(new Error('Network error'));
      const fallbackRes = await preparePortfolioBobContext({ source: 'test' }, [], rejectingFetcher);
      expect(fallbackRes.projects).toEqual([]);
    });
  });

  // =========================================================================
  // 5. reconcileMarkdown.ts
  // =========================================================================
  describe('reconcileMarkdown.ts', () => {
    it('reconcileMarkdownNode returns current node directly when nodes are identical', () => {
      const el = document.createElement('div');
      el.textContent = 'identical';
      const cloned = el.cloneNode(true);
      expect(reconcileMarkdownNode(el, cloned)).toBe(el);
    });

    it('reconcileMarkdownNode preserves specialized widget hosts with matching attributes', () => {
      const parent = document.createElement('div');

      // 1. Intelligent answer host
      const curAns = document.createElement('div');
      curAns.className = 'intelligent-answer-host';
      curAns.setAttribute('data-intelligent-answer', 'ans-123');
      curAns.setAttribute('title', 'mounted state');
      parent.appendChild(curAns);
      const nextAns = document.createElement('div');
      nextAns.className = 'intelligent-answer-host';
      nextAns.setAttribute('data-intelligent-answer', 'ans-123');
      expect(reconcileMarkdownNode(curAns, nextAns)).toBe(curAns);

      // 2. Structured diagram host
      const curDiag = document.createElement('div');
      curDiag.className = 'structured-diagram-host';
      curDiag.setAttribute('data-structured-diagram', 'diag-456');
      curDiag.setAttribute('title', 'mounted svg');
      const nextDiag = document.createElement('div');
      nextDiag.className = 'structured-diagram-host';
      nextDiag.setAttribute('data-structured-diagram', 'diag-456');
      expect(reconcileMarkdownNode(curDiag, nextDiag)).toBe(curDiag);

      // 3. Interactive chart card
      const curChart = document.createElement('div');
      curChart.className = 'interactive-chart-card';
      curChart.setAttribute('data-chart-spec', '{"type":"bar"}');
      curChart.innerHTML = '<canvas></canvas>';
      const nextChart = document.createElement('div');
      nextChart.className = 'interactive-chart-card';
      nextChart.setAttribute('data-chart-spec', '{"type":"bar"}');
      expect(reconcileMarkdownNode(curChart, nextChart)).toBe(curChart);

      // 4. Mermaid panel
      const curMer = document.createElement('div');
      curMer.className = 'mermaid-panel';
      curMer.setAttribute('data-mermaid-source', 'graph TD; A-->B');
      curMer.setAttribute('data-mermaid-session', 'sess-1');
      curMer.innerHTML = '<svg></svg>';
      const nextMer = document.createElement('div');
      nextMer.className = 'mermaid-panel';
      nextMer.setAttribute('data-mermaid-source', 'graph TD; A-->B');
      nextMer.setAttribute('data-mermaid-session', 'sess-1');
      expect(reconcileMarkdownNode(curMer, nextMer)).toBe(curMer);

      // 5. Code subwindow
      const curCode = document.createElement('div');
      curCode.className = 'code-subwindow';
      curCode.setAttribute('data-subwindow-id', '1');
      curCode.textContent = 'console.log("hello");';
      const nextCode = document.createElement('div');
      nextCode.className = 'code-subwindow';
      nextCode.textContent = 'console.log("hello");';
      expect(reconcileMarkdownNode(curCode, nextCode)).toBe(curCode);

      // 6. Changed chart spec replaces node
      const diffChart = document.createElement('div');
      diffChart.className = 'interactive-chart-card';
      diffChart.setAttribute('data-chart-spec', '{"type":"line"}');
      expect(reconcileMarkdownNode(curChart, diffChart)).toBe(diffChart);

      // 7. Changed mermaid source replaces node
      const diffMer = document.createElement('div');
      diffMer.className = 'mermaid-panel';
      diffMer.setAttribute('data-mermaid-source', 'graph LR; C-->D');
      diffMer.setAttribute('data-mermaid-session', 'sess-1');
      expect(reconcileMarkdownNode(curMer, diffMer)).toBe(diffMer);
    });

    it('reconcileMarkdownNode reconciles HTML elements, attributes, text nodes, and child lists', () => {
      const container = document.createElement('div');
      const current = document.createElement('ul');
      current.setAttribute('class', 'list old-class');
      current.setAttribute('data-remove', 'true');
      const li1 = document.createElement('li');
      li1.textContent = 'Item 1';
      const li2 = document.createElement('li');
      li2.textContent = 'Item 2 to remove';
      current.appendChild(li1);
      current.appendChild(li2);
      container.appendChild(current);

      const next = document.createElement('ul');
      next.setAttribute('class', 'list new-class');
      next.setAttribute('data-new', 'yes');
      const nextLi1 = document.createElement('li');
      nextLi1.textContent = 'Item 1 updated';
      const nextLi2 = document.createElement('li');
      nextLi2.textContent = 'Item 3 added';
      next.appendChild(nextLi1);
      next.appendChild(nextLi2);

      const reconciled = reconcileMarkdownNode(current, next);
      expect(reconciled).toBe(current);
      expect(current.getAttribute('class')).toBe('list new-class');
      expect(current.hasAttribute('data-remove')).toBe(false);
      expect(current.getAttribute('data-new')).toBe('yes');
      expect(current.childNodes.length).toBe(2);
      expect(current.childNodes[0].textContent).toBe('Item 1 updated');
      expect(current.childNodes[1].textContent).toBe('Item 3 added');
    });

    it('reconcileMarkdownNode replaces mismatched tags or modified widget subwindows', () => {
      const container = document.createElement('div');
      const curP = document.createElement('p');
      container.appendChild(curP);
      const nextSpan = document.createElement('span');

      const result = reconcileMarkdownNode(curP, nextSpan);
      expect(result).toBe(nextSpan);
      expect(container.firstChild).toBe(nextSpan);

      // Changed code widget
      const curCode = document.createElement('div');
      curCode.className = 'code-subwindow';
      curCode.textContent = 'old code';
      container.replaceChild(curCode, nextSpan);

      const nextCode = document.createElement('div');
      nextCode.className = 'code-subwindow';
      nextCode.textContent = 'new code';

      const resCode = reconcileMarkdownNode(curCode, nextCode);
      expect(resCode).toBe(nextCode);
      expect(container.firstChild).toBe(nextCode);
    });

    it('reconcileMarkdownNode appends extra children and updates text nodes', () => {
      const parent = document.createElement('div');
      const curList = document.createElement('ul');
      const item1 = document.createElement('li');
      item1.textContent = 'Only Item';
      curList.appendChild(item1);
      parent.appendChild(curList);

      const nextList = document.createElement('ul');
      const nItem1 = document.createElement('li');
      nItem1.textContent = 'First Item';
      const nItem2 = document.createElement('li');
      nItem2.textContent = 'Second Item';
      nextList.appendChild(nItem1);
      nextList.appendChild(nItem2);

      const reconciled = reconcileMarkdownNode(curList, nextList);
      expect(reconciled.childNodes.length).toBe(2);
      expect(reconciled.childNodes[1].textContent).toBe('Second Item');

      // Reconcile text nodes
      const text1 = document.createTextNode('Original');
      const text2 = document.createTextNode('Updated');
      const resText = reconcileMarkdownNode(text1, text2);
      expect(resText.nodeValue).toBe('Updated');
    });
  });

  // =========================================================================
  // 6. conversationUrl.ts
  // =========================================================================
  describe('conversationUrl.ts', () => {
    it('parseSharedConversation parses token and optional session identifier', () => {
      const token = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
      expect(token.length).toBe(43);

      // Token only
      const p1 = parseSharedConversation(`/shared/${token}`);
      expect(p1).toEqual({ sessionId: undefined, token });

      // Session + Token
      const p2 = parseSharedConversation(`/shared/0123456789abcdef0123456789abcdef/${token}`);
      expect(p2).toEqual({ sessionId: '0123456789abcdef0123456789abcdef', token });

      // Legacy session + Token
      const p3 = parseSharedConversation(`/shared/legacy/${token}/`);
      expect(p3).toEqual({ sessionId: 'legacy', token });

      // Invalid paths
      expect(parseSharedConversation('/shared/invalid-token')).toBeNull();
      expect(parseSharedConversation('/notes')).toBeNull();
    });

    it('isNotesPath and isProjectsPath validate known application paths', () => {
      expect(isNotesPath('/notes')).toBe(true);
      expect(isNotesPath('/notes/')).toBe(true);
      expect(isNotesPath('/notes/new')).toBe(true);
      expect(isNotesPath('/notes/42')).toBe(true);
      expect(isNotesPath('/notes/invalid_slug')).toBe(false);

      expect(isProjectsPath('/projects')).toBe(true);
      expect(isProjectsPath('/projects/view/proj-alpha')).toBe(true);
      expect(isProjectsPath('/projects/tabs/portfolio')).toBe(true);
      expect(isProjectsPath('/projects/tabs/people')).toBe(true);
      expect(isProjectsPath('/projects/random-subpath')).toBe(false);
    });

    it('updateConversationUrl updates query params and ignores office routes', () => {
      const replaceSpy = vi.spyOn(window.history, 'replaceState');

      // Normal path
      window.history.replaceState({}, '', '/');
      updateConversationUrl('session-101', 'project-202');
      expect(replaceSpy).toHaveBeenCalled();
      const lastCall = replaceSpy.mock.calls[replaceSpy.mock.calls.length - 1];
      const url = lastCall[2] as URL;
      expect(url.searchParams.get('conversation')).toBe('session-101');
      expect(url.searchParams.get('project')).toBe('project-202');

      // Clear params
      updateConversationUrl('', '');
      const clearedCall = replaceSpy.mock.calls[replaceSpy.mock.calls.length - 1];
      const clearedUrl = clearedCall[2] as URL;
      expect(clearedUrl.searchParams.has('conversation')).toBe(false);
      expect(clearedUrl.searchParams.has('project')).toBe(false);

      // Office path should be ignored
      window.history.replaceState({}, '', '/office/document-1');
      replaceSpy.mockClear();
      updateConversationUrl('sess-9', 'proj-9');
      expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('navigateNotes and navigateProjects transition routes while preserving history state', () => {
      const pushSpy = vi.spyOn(window.history, 'pushState');
      const replaceSpy = vi.spyOn(window.history, 'replaceState');

      // Navigate into notes
      window.history.replaceState({}, '', '/');
      navigateNotes(true);
      expect(pushSpy).toHaveBeenCalled();
      let state = pushSpy.mock.calls[0][0] as { notesReturnPath?: string };
      expect(state.notesReturnPath).toBe('/');

      // Navigate out of notes
      window.history.replaceState({ notesReturnPath: '/' }, '', '/notes');
      navigateNotes(false);
      expect(pushSpy).toHaveBeenCalled();

      // Navigate into projects
      window.history.replaceState({}, '', '/');
      navigateProjects(true);
      expect(pushSpy).toHaveBeenCalled();
      state = pushSpy.mock.calls[pushSpy.mock.calls.length - 1][0] as { projectsReturnPath?: string };
      expect(state.projectsReturnPath).toBe('/');

      // Navigate into projects with replace
      navigateProjects(true, true);
      expect(replaceSpy).toHaveBeenCalled();

      // Navigate out of projects
      window.history.replaceState({ projectsReturnPath: '/notes' }, '', '/projects');
      navigateProjects(false);
      expect(pushSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. interfaceMotion.ts
  // =========================================================================
  describe('interfaceMotion.ts', () => {
    it('startInterfaceMotion observes added panels and animates entry', async () => {
      const cleanup = startInterfaceMotion();

      const panel = document.createElement('div');
      panel.className = 'tasks-view';
      document.body.appendChild(panel);

      // Allow requestAnimationFrame and mutation observer to trigger
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(Element.prototype.animate).toHaveBeenCalled();
      panel.remove();
      cleanup();
    });

    it('startInterfaceMotion handles dialog open attributes and active view mutations', async () => {
      const cleanup = startInterfaceMotion();

      const dialog = document.createElement('dialog');
      dialog.className = 'feature-dialog';
      document.body.appendChild(dialog);
      dialog.setAttribute('open', '');

      const activeViewContainer = document.createElement('div');
      document.body.appendChild(activeViewContainer);
      activeViewContainer.setAttribute('data-active-view', 'projects');

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(typeof cleanup).toBe('function');

      cleanup();
      dialog.remove();
      activeViewContainer.remove();
    });
  });

  // =========================================================================
  // 8. viewport.ts
  // =========================================================================
  describe('viewport.ts', () => {
    it('trackVisibleViewport sets CSS properties on root element and cleans up', () => {
      const cleanup = trackVisibleViewport();
      const rootStyle = document.documentElement.style;

      expect(rootStyle.getPropertyValue('--visible-height')).toBeTruthy();
      expect(rootStyle.getPropertyValue('--visible-top')).toBeTruthy();

      // Simulate resize
      window.dispatchEvent(new Event('resize'));

      cleanup();
      expect(rootStyle.getPropertyValue('--visible-height')).toBe('');
      expect(rootStyle.getPropertyValue('--visible-top')).toBe('');
    });

    it('trackVisibleViewport preserves pinch zoom when scale differs from 1', () => {
      vi.stubGlobal('visualViewport', {
        scale: 1.5,
        height: 600,
        offsetTop: 20,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });

      const cleanup = trackVisibleViewport();
      expect(typeof cleanup).toBe('function');
      cleanup();
    });

    it('trackVisibleViewport scrolls active input into view for coarse pointers', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      input.getBoundingClientRect = vi.fn().mockReturnValue({
        top: 2000,
        bottom: 2040,
        left: 10,
        right: 100,
        width: 90,
        height: 40,
      });
      input.scrollIntoView = vi.fn();

      const cleanup = trackVisibleViewport();
      expect(input.scrollIntoView).toHaveBeenCalled();
      cleanup();
      input.remove();
    });
  });

  // =========================================================================
  // 9. appRegistry.ts
  // =========================================================================
  describe('appRegistry.ts', () => {
    it('workspaceAppGroups defines standard directory groups', () => {
      expect(workspaceAppGroups.length).toBe(7);
      expect(workspaceAppGroups.map(g => g.id)).toEqual([
        'projects',
        'workspace',
        'create',
        'knowledge',
        'automation',
        'tools',
        'installed',
      ]);
    });

    it('workspaceAppGroup classifies apps into appropriate groups', () => {
      const makeApp = (id: string): WorkspaceApp => ({
        id,
        name: id,
        description: '',
        kind: 'core',
        desktop_only: false,
        launch: { kind: 'view' },
      });

      expect(workspaceAppGroup(makeApp('projects'))).toBe('projects');
      expect(workspaceAppGroup(makeApp('tasks'))).toBe('projects');
      expect(workspaceAppGroup(makeApp('productivity'))).toBe('projects');
      expect(workspaceAppGroup(makeApp('chat'))).toBe('workspace');
      expect(workspaceAppGroup(makeApp('notes'))).toBe('workspace');
      expect(workspaceAppGroup(makeApp('office'))).toBe('workspace');
      expect(workspaceAppGroup(makeApp('people'))).toBe('workspace');
      expect(workspaceAppGroup(makeApp('presentations'))).toBe('create');
      expect(workspaceAppGroup(makeApp('knowledge'))).toBe('knowledge');
      expect(workspaceAppGroup(makeApp('research'))).toBe('knowledge');
      expect(workspaceAppGroup(makeApp('docmost'))).toBe('knowledge');
      expect(workspaceAppGroup(makeApp('workflows'))).toBe('automation');
      expect(workspaceAppGroup(makeApp('decisions'))).toBe('automation');
      expect(workspaceAppGroup(makeApp('zen'))).toBe('automation');
      expect(workspaceAppGroup(makeApp('search'))).toBe('tools');
      expect(workspaceAppGroup(makeApp('connections'))).toBe('tools');
      expect(workspaceAppGroup(makeApp('custom_plugin'))).toBe('installed');
    });

    it('useAppRegistry hook fetches registered apps when account is active', async () => {
      const mockApps: WorkspaceApp[] = [
        { id: 'notes', name: 'Notes', description: 'Sticky notes', kind: 'core', desktop_only: false, launch: { kind: 'view' } },
      ];

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ apps: mockApps }),
      }));

      let hookOutput: ReturnType<typeof useAppRegistry> | null = null;
      function TestComponent({ account }: { account?: string }) {
        const res = useAppRegistry(account);
        useEffect(() => {
          hookOutput = res;
        });
        return null;
      }

      // 1. Without account
      await act(async () => {
        root.render(React.createElement(TestComponent, { account: undefined }));
      });
      expect(hookOutput?.loaded).toBe(false);
      expect(hookOutput?.apps).toEqual([]);

      // 2. With active account
      await act(async () => {
        root.render(React.createElement(TestComponent, { account: 'user-1' }));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(hookOutput?.loaded).toBe(true);
      expect(hookOutput?.error).toBe(false);
      expect(hookOutput?.apps.length).toBe(1);
    });

    it('useAppRegistry sets error true when fetch rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

      let hookOutput: ReturnType<typeof useAppRegistry> | null = null;
      function TestErrorComponent({ account }: { account?: string }) {
        const res = useAppRegistry(account);
        useEffect(() => {
          hookOutput = res;
        });
        return null;
      }

      await act(async () => {
        root.render(React.createElement(TestErrorComponent, { account: 'user-err' }));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(hookOutput?.loaded).toBe(true);
      expect(hookOutput?.error).toBe(true);
    });
  });

  // =========================================================================
  // 10. requestDelivery.ts
  // =========================================================================
  describe('requestDelivery.ts', () => {
    it('deliveryStates lists all valid delivery lifecycle states in order', () => {
      expect(deliveryStates).toEqual([
        'sending',
        'accepted',
        'queued',
        'running',
        'streaming',
        'saving',
        'completed',
        'failed',
        'cancelled',
      ]);
    });

    it('applyDeliveryStep advances states and avoids backtracking terminal requests', () => {
      const initial: RequestDelivery = {};
      const t1 = '2026-10-28T10:00:00Z';
      const t2 = '2026-10-28T10:00:05Z';
      const t3 = '2026-10-28T10:00:10Z';

      // 1. Advance to running
      const step1 = applyDeliveryStep(initial, { state: 'running', timestamp: t1, source: 'server' });
      expect(step1.deliveryState).toBe('running');
      expect(step1.deliveryTimeline?.length).toBe(1);

      // 2. Duplicate step ignored
      const dup = applyDeliveryStep(step1, { state: 'running', timestamp: t1, source: 'server' });
      expect(dup).toBe(step1);

      // 3. Advance to completed
      const step2 = applyDeliveryStep(step1, { state: 'completed', timestamp: t2, source: 'server' });
      expect(step2.deliveryState).toBe('completed');

      // 4. Stale/delayed running step cannot move backwards from completed
      const stale = applyDeliveryStep(step2, { state: 'streaming', timestamp: t3, source: 'server' });
      expect(stale.deliveryState).toBe('completed'); // Remains completed
      expect(stale.deliveryTimeline?.length).toBe(3); // Timeline records event
    });

    it('applyDeliveryEvent processes delivery events, done, error, and delta', () => {
      const msg: RequestDelivery = {};

      // delivery_state saving sets answerReadyAt
      const saving = applyDeliveryEvent(msg, {
        type: 'delivery_state',
        state: 'saving',
        timestamp: '2026-10-28T12:00:00Z',
      });
      expect(saving.deliveryState).toBe('saving');
      expect(saving.answerReadyAt).toBe('2026-10-28T12:00:00Z');

      // delta event
      const streaming = applyDeliveryEvent({ deliveryState: 'running' }, { type: 'delta', text: 'token' });
      expect(streaming.deliveryState).toBe('streaming');

      // done event
      const done = applyDeliveryEvent({ deliveryState: 'streaming' }, { type: 'done' });
      expect(done.deliveryState).toBe('completed');

      // cancelled error event
      const cancelled = applyDeliveryEvent({ deliveryState: 'running' }, { type: 'error', cancelled: true });
      expect(cancelled.deliveryState).toBe('cancelled');

      // failure error event
      const failed = applyDeliveryEvent({ deliveryState: 'running' }, { type: 'error', cancelled: false });
      expect(failed.deliveryState).toBe('failed');
    });

    it('localDeliveryStep stamps a local step with current timestamp', () => {
      const now = new Date('2026-10-28T15:30:00Z');
      const updated = localDeliveryStep({}, 'sending', now);
      expect(updated.deliveryState).toBe('sending');
      expect(updated.deliveryTimeline?.[0]).toEqual({
        state: 'sending',
        timestamp: now.toISOString(),
        source: 'local',
      });
    });
  });

  // =========================================================================
  // 11. sourcePreview.ts
  // =========================================================================
  describe('sourcePreview.ts', () => {
    it('sourceMetadata extracts URL, title, quote and preview', () => {
      const link = document.createElement('a');
      link.href = 'https://example.org/docs/reference.html';
      link.textContent = 'Documentation Page';
      link.title = 'Supporting snippet quote';

      const meta = sourceMetadata(link, 'web', 'Preview text');
      expect(meta.title).toBe('Documentation Page');
      expect(meta.url).toBe('https://example.org/docs/reference.html');
      expect(meta.kind).toBe('web');
      expect(meta.preview).toBe('Preview text');
      expect(meta.quote).toBe('Supporting snippet quote');

      // Numeric label fallback
      link.textContent = '[1]';
      const metaNumeric = sourceMetadata(link, 'web');
      expect(metaNumeric.title).toBe('example.org');

      // Document kind fallback
      const docLink = document.createElement('a');
      docLink.href = '/files/architecture-spec.pdf';
      docLink.textContent = '2';
      const metaDoc = sourceMetadata(docLink, 'document');
      expect(metaDoc.title).toBe('architecture-spec.pdf');
    });

    it('attachSourceMetadata writes metadata to element dataset attributes', () => {
      const link = document.createElement('a');
      attachSourceMetadata(link, {
        title: 'Source Title',
        url: 'https://example.com/api',
        kind: 'web',
        quote: 'Citation quote',
        preview: 'Preview string',
      });

      expect(link.dataset.sourceTitle).toBe('Source Title');
      expect(link.dataset.sourceUrl).toBe('https://example.com/api');
      expect(link.dataset.sourceKind).toBe('web');
      expect(link.dataset.sourceQuote).toBe('Citation quote');
      expect(link.dataset.citationPreview).toBe('Preview string');
    });

    it('sourcePopupPosition positions popup below or above target depending on viewport clearance', () => {
      // Plentiful space below
      const posBelow = sourcePopupPosition(
        { left: 100, top: 100, bottom: 130 },
        { width: 1024, height: 768 },
      );
      expect(posBelow.top).toBe(138); // bottom + 8
      expect(posBelow.left).toBe(100);
      expect(posBelow.width).toBe(460);

      // Tight space below (<260), ample space above -> positions above
      const posAbove = sourcePopupPosition(
        { left: 100, top: 600, bottom: 630 },
        { width: 1024, height: 700 }, // below = 70
      );
      expect(posAbove.bottom).toBe(700 - 600 + 8); // 108
      expect(posAbove.maxHeight).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 12. missedCalls.ts
  // =========================================================================
  describe('missedCalls.ts', () => {
    it('missedCallColors lists expected palette entries', () => {
      expect(missedCallColors).toEqual(['rose', 'yellow', 'mint', 'sky', 'lavender']);
    });

    it('groupMissedCalls groups reminder and caller items, updating latest timestamp', () => {
      const items: MissedCall[] = [
        { id: 'rem-1', title: 'Standup', room_id: null, kind: 'reminder', color: 'mint', occurred_at: '2026-10-28T09:00:00Z' },
        { id: 'call-1', title: 'Team Call', room_id: 101, caller: 'Bob Manager', occurred_at: '2026-10-28T10:00:00Z' },
        { id: 'call-2', title: 'Team Call Followup', room_id: 101, caller: 'Bob Manager', occurred_at: '2026-10-28T11:00:00Z' },
        { id: 'rem-2', title: 'Reminder Butter', room_id: null, kind: 'reminder', color: 'butter', occurred_at: '2026-10-28T08:00:00Z' },
      ];

      const groups = groupMissedCalls(items);
      expect(groups.length).toBe(3); // rem-1, Bob Manager (merged), rem-2

      // Ordered by latest occurred_at descending
      expect(groups[0].latest.id).toBe('call-2');
      expect(groups[0].calls.length).toBe(2);

      // Butter color is mapped to yellow on single reminder
      const singleButter = groupMissedCalls([{ id: 'rem-butter', title: 'Reminder Butter', room_id: null, kind: 'reminder', color: 'butter', occurred_at: '2026-10-28T08:00:00Z' }]);
      expect(singleButter[0].color).toBe('yellow');

      // In multi-item groups, butter group gets a valid palette color from allocation
      const butterGroup = groups.find(g => g.key === 'rem-2');
      expect(missedCallColors).toContain(butterGroup?.color);
    });

    it('groupMissedCalls balances colors while preserving previous color allocations', () => {
      const items: MissedCall[] = [
        { id: 'c1', title: 'Call 1', room_id: 1, caller: 'Alice', occurred_at: '2026-10-28T10:00:00Z' },
        { id: 'c2', title: 'Call 2', room_id: 2, caller: 'Charlie', occurred_at: '2026-10-28T10:05:00Z' },
      ];

      const previousColors = { Alice: 'sky' };
      const groups = groupMissedCalls(items, previousColors);
      const aliceGroup = groups.find(g => g.key === 'Alice');
      expect(aliceGroup?.color).toBe('sky');
    });
  });
});
