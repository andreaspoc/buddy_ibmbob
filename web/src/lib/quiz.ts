export type QuizSection = { id: string; title: string };
export type QuizQuestion = { id: string; type: 'single' | 'multiple' | 'text'; question: string; options?: string[]; section_id?: string; topic?: string; learning_objective?: string; difficulty?: 'easy' | 'medium' | 'hard' };
export type Quiz = { key: string; title: string; learning_objectives?: string[]; sections?: QuizSection[]; questions: QuizQuestion[] };
export type QuizAnswers = Record<string, string | number[]>;
import type { ChatMessage } from '../types';

export function quizKey(raw: string) {
  let value = 2166136261;
  for (const byte of new TextEncoder().encode(raw)) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}

// Only public fields leave this parser. Answer keys/rubrics never enter the form.
function publicQuiz(value: any, raw: string): Quiz {
  if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 30) throw Error('Invalid quiz');
  const objectives = value.learning_objectives ?? [];
  if (!Array.isArray(objectives) || objectives.length > 20 || objectives.some((o: unknown) => typeof o !== 'string' || !o.trim() || o.length > 500) || value.learning_objectives === null) throw Error('Invalid learning objectives');
  const sections = value.sections ?? [];
  if (!Array.isArray(sections) || sections.length > 30 || value.sections === null) throw Error('Invalid sections');
  const sectionIds = new Set<string>();
  const publicSections = sections.map((section: any): QuizSection => {
    if (!section || typeof section.id !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(section.id) || sectionIds.has(section.id) || typeof section.title !== 'string' || !section.title.trim() || section.title.length > 200) throw Error('Invalid section');
    sectionIds.add(section.id);
    return { id: section.id, title: section.title };
  });
  const ids = new Set();
  const questions = value.questions.map((q: any): QuizQuestion => {
    if (!q || typeof q.id !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(q.id) || ids.has(q.id) || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 2000 || !['single', 'multiple', 'text'].includes(q.type)) throw Error('Invalid question');
    ids.add(q.id);
    if (q.section_id !== undefined && (typeof q.section_id !== 'string' || !sectionIds.has(q.section_id))) throw Error('Unknown section');
    for (const field of ['topic', 'learning_objective']) if (q[field] !== undefined && (typeof q[field] !== 'string' || !q[field].trim() || q[field].length > 500)) throw Error('Invalid question metadata');
    if (q.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(q.difficulty)) throw Error('Invalid difficulty');
    const metadata = { section_id: q.section_id, topic: q.topic, learning_objective: q.learning_objective, difficulty: q.difficulty };
    if (typeof q.explanation !== 'string' || !q.explanation.trim() || q.explanation.length > 4000 || (q.source !== undefined && (typeof q.source !== 'string' || q.source.length > 1000))) throw Error('Missing explanation');
    if (q.type === 'text') {
      if (typeof q.answer !== 'string' || !q.answer.trim() || q.answer.length > 4000 || typeof q.rubric !== 'string' || !q.rubric.trim() || q.rubric.length > 4000) throw Error('Missing rubric');
      return { ...metadata, id: q.id, type: q.type, question: q.question };
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8 || q.options.some((o: unknown) => typeof o !== 'string' || !o.trim() || o.length > 1000) || new Set(q.options.map((o: string) => o.trim().toLowerCase())).size !== q.options.length) throw Error('Invalid options');
    if (!Array.isArray(q.answer) || !q.answer.length || q.answer.some((i: unknown) => !Number.isInteger(i) || Number(i) < 0 || Number(i) >= q.options.length) || new Set(q.answer).size !== q.answer.length || (q.type === 'single' && q.answer.length !== 1)) throw Error('Invalid answer key');
    return { ...metadata, id: q.id, type: q.type, question: q.question, options: [...q.options] };
  });
  return { key: quizKey(raw), title: value.title, learning_objectives: [...objectives], sections: publicSections, questions };
}

function parseBlocks<T>(content: string, streaming: boolean, kind: string, normalize: (value: any, raw: string) => T, limit=200000) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const visible: string[] = [], items: T[] = [];
  let error = false;
  let fence = '';
  let i = 0;
  while (i < lines.length) {
    const opening = lines[i].match(/^ {0,3}(?=(`{3,}|~{3,}))\1(.*)$/);
    const language = opening?.[2].trim().split(/\s+/)[0].toLowerCase() || '';
    if (fence) {
      visible.push(lines[i]);
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(lines[i])) fence = '';
      i++;
      continue;
    }
    if (opening && (language === kind || (streaming && i === lines.length - 1 && language && kind.startsWith(language)))) {
      let end = i + 1;
      const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`);
      while (end < lines.length && !closing.test(lines[end])) end++;
      if (end === lines.length) { if (!streaming) error = true; break; }
      if (!streaming) {
        const raw = lines.slice(i + 1, end).join('\n').trim();
        try { if (raw.length > limit) throw Error(); items.push(normalize(JSON.parse(raw), raw)); } catch { error = true; }
      }
      i = end + 1;
    } else {
      visible.push(lines[i]);
      if (opening) fence = opening[1];
      i++;
    }
  }
  return { text: visible.join('\n').trim(), items, error };
}

export function parseQuizzes(content: string, streaming = false) {
  const parsed = parseBlocks(content, streaming, 'bobquiz', publicQuiz);
  return {text:parsed.text, quizzes:parsed.items, error:parsed.error};
}

export function isQuizCreation(prompt: string) {
  if (prompt.startsWith('Quiz submission:')) return false;
  return /use a bobquiz form/i.test(prompt) || /\b(?:quiz|test) me\b/i.test(prompt) ||
    (/\b(?:create|build|make|generate|prepare|need|want|give me)\b/i.test(prompt) && /\b(?:quiz|exam|knowledge test|practice test|multiple.choice questions|test\b.*\b(?:doc|document|uploaded))\b/i.test(prompt));
}

export type QuizResource = {title:string;url:string;why:string;verified:true};
export type ReviewedQuestion = {id:string;question:string;submitted_answer:string | string[];correct_answer:string | string[];score:0 | 0.5 | 1 | null;explanation:string;review_reason?:string;source?:string;study_topic:string;resources:QuizResource[]};
export type QuizResult = {quiz_key:string;title:string;questions:ReviewedQuestion[];total_points:number;eligible_questions:number;percentage:number | null;reading_status:string};
function quizResult(value:any): QuizResult {
  if (!value || !/^[a-f0-9]{8}$/.test(value.quiz_key) || typeof value.title !== 'string' || typeof value.reading_status !== 'string' || !Array.isArray(value.questions) || !value.questions.length || value.questions.length>30) throw Error('Invalid review');
  const ids=new Set();
  for (const q of value.questions) {
    if (!q || typeof q.id !== 'string' || ids.has(q.id) || typeof q.question !== 'string' || typeof q.explanation !== 'string' || typeof q.study_topic !== 'string' || ![0,0.5,1,null].includes(q.score) || !Array.isArray(q.resources)) throw Error('Invalid question review');
    ids.add(q.id);
    for (const answer of [q.submitted_answer,q.correct_answer]) if (typeof answer !== 'string' && (!Array.isArray(answer) || answer.some((item:unknown)=>typeof item !== 'string'))) throw Error('Invalid reviewed answer');
    if (q.score===null && (typeof q.review_reason !== 'string' || !q.review_reason)) throw Error('Missing review reason');
    if (q.review_reason!==undefined && typeof q.review_reason !== 'string') throw Error('Invalid review reason');
    if (q.source !== undefined && q.source !== null && typeof q.source !== 'string') throw Error('Invalid source');
    for (const resource of q.resources) {
      if (!resource || typeof resource.title !== 'string' || typeof resource.why !== 'string' || resource.verified!==true || typeof resource.url !== 'string') throw Error('Unverified reading');
      const url = new URL(resource.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid reading link');
    }
  }
  const eligible=value.questions.filter((q:ReviewedQuestion)=>q.score!==null).length;
  const points=value.questions.reduce((sum:number,q:ReviewedQuestion)=>sum+(q.score||0),0);
  return {...value,total_points:points,eligible_questions:eligible,percentage:eligible?Math.round(points/eligible*1000)/10:null};
}
export function parseQuizResults(content:string, streaming=false) {
  const parsed=parseBlocks(content,streaming,'bobquizresult',quizResult,1000000);
  return {text:parsed.text,results:parsed.items,error:parsed.error};
}

export function quizSubmission(key: string, answers: QuizAnswers) {
  return `Quiz submission: ${key}\nAnswers:\n${JSON.stringify(answers)}`;
}
export function submittedQuizAnswers(prompt: string, key: string): QuizAnswers | undefined {
  const prefix = `Quiz submission: ${key}\nAnswers:\n`;
  if (!prompt.startsWith(prefix)) return;
  try { const value = JSON.parse(prompt.slice(prefix.length)); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return; }
}

export function quizAttempt(messages: ChatMessage[], key: string): QuizAnswers | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== 'user') continue;
    const answers = submittedQuizAnswers(messages[index].content, key);
    if (!answers) continue;
    const response = messages.slice(index + 1).find(message => message.role === 'assistant');
    if (response && !response.isStreaming && /^(?:Error|Stopped)/i.test(response.statusText || '')) continue;
    return answers;
  }
}
