// The sign-up questions. The website renders whatever this file defines, and the server only accepts
// these exact option ids, so answers stay clean and safe to hand to the AI.
export const QUESTIONS = [
  { id: 'use', title: 'What will you mostly use Viora for?', hint: 'Pick all that apply.', multi: true, options: [
    { id: 'study', label: 'Studying and homework' },
    { id: 'code', label: 'Coding and debugging' },
    { id: 'write', label: 'Writing and editing' },
    { id: 'research', label: 'Research and fact-finding' },
    { id: 'work', label: 'Work and business tasks' },
    { id: 'explore', label: 'Just exploring' }
  ] },
  { id: 'role', title: 'Which best describes you?', multi: false, options: [
    { id: 'student', label: 'Student' },
    { id: 'developer', label: 'Developer or engineer' },
    { id: 'professional', label: 'Working professional' },
    { id: 'creator', label: 'Creator or writer' },
    { id: 'other', label: 'Something else' }
  ] },
  { id: 'level', title: 'How much have you used AI assistants before?', multi: false, options: [
    { id: 'new', label: 'Brand new to it' },
    { id: 'some', label: 'A few times' },
    { id: 'regular', label: 'I use them regularly' },
    { id: 'power', label: 'Power user' }
  ] },
  { id: 'style', title: 'How should Viora answer you?', multi: false, options: [
    { id: 'brief', label: 'Short and to the point' },
    { id: 'steps', label: 'Step by step, with explanations' },
    { id: 'friendly', label: 'Casual and friendly' },
    { id: 'formal', label: 'Formal and precise' }
  ] },
  { id: 'topics', title: 'Which topics interest you most?', hint: 'Pick all that apply.', multi: true, options: [
    { id: 'tech', label: 'Technology' },
    { id: 'science', label: 'Science' },
    { id: 'math', label: 'Math' },
    { id: 'business', label: 'Business and money' },
    { id: 'arts', label: 'Art, music and writing' },
    { id: 'games', label: 'Games' },
    { id: 'news', label: 'News and current events' }
  ] }
];

/** Validate raw answers. Returns { answers } on success or { error } with a message for the user. */
export function cleanAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Please answer all 5 questions.' };
  const answers = {};
  for (const q of QUESTIONS) {
    const raw = input[q.id];
    const picked = [...new Set((Array.isArray(raw) ? raw : [raw]).filter((x) => typeof x === 'string'))];
    const valid = picked.filter((id) => q.options.some((o) => o.id === id));
    if (!valid.length || valid.length !== picked.length) return { error: 'Please answer all 5 questions.' };
    if (!q.multi && valid.length > 1) return { error: 'Please answer all 5 questions.' };
    answers[q.id] = valid;
  }
  return { answers };
}

/** Plain-text summary for the AI's system prompt. Only fixed labels from QUESTIONS can appear here. */
export function profileText(answers) {
  if (!answers) return '';
  const lines = [];
  for (const q of QUESTIONS) {
    const labels = (answers[q.id] || []).map((id) => q.options.find((o) => o.id === id)?.label).filter(Boolean);
    if (labels.length) lines.push(`- ${q.title} ${labels.join('; ')}`);
  }
  return lines.join('\n');
}
