export function parseLearningUrl(path = window.location.pathname) {
  const match = path.match(/^\/learning\/(?:folders|classes)\/([^/]+)(?:\/(books|quizzes)\/([^/]+))?\/?$/);
  if (!match) return {folderId:'',bookId:null as string|null,quizId:null as string|null};
  try { return {folderId:decodeURIComponent(match[1]),bookId:match[2]==='books'?decodeURIComponent(match[3]):null,quizId:match[2]==='quizzes'?decodeURIComponent(match[3]):null}; }
  catch { return {folderId:'',bookId:null,quizId:null}; }
}
export function learningPath(folder: string, book: string|null, quiz: string|null, tab: string) {
  const base = folder ? `/learning/folders/${encodeURIComponent(folder)}` : '/learning';
  return book ? `${base}/books/${encodeURIComponent(book)}` : quiz ? `${base}/quizzes/${encodeURIComponent(quiz)}` : tab==='quizzes' || tab==='lessons' || tab==='classes' || tab==='completion' || tab==='chapters' || tab==='notes' ? `${base}?tab=${tab}` : base;
}
