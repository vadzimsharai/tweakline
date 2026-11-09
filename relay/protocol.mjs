import { z } from 'zod';

const KIB = 1024;
const MIB = 1024 * KIB;

export const MAX_WAIT_SECONDS = 50;
export const MAX_TEXT_LENGTH = 256 * KIB;
export const MAX_FILE_BYTES = 10 * MIB;
export const MAX_STATUS_TEXT_LENGTH = 80;
// A session file is rewritten on every event, so its size is what each event costs.
export const MAX_EVENT_BYTES = MIB;
export const MAX_SESSION_EVENT_BYTES = 8 * MIB;
export const MAX_SESSION_FILES = 200;
export const MAX_SESSION_FILE_BYTES = 200 * MIB;
export const MAX_FREEFORM_DEPTH = 32;
export const MAX_ASK_BYTES = 16 * KIB;
export const MAX_NOTES_BYTES = 256 * KIB;
export const MAX_PATCH_BYTES = MIB;
export const AI_STATES = ['thinking', 'typing', 'idle'];
const CONTENT_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

export class TooLarge extends Error {}

export const isContentType = (type) => typeof type === 'string' && CONTENT_TYPE_PATTERN.test(type);
export const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function depthWithin(value, depthLeft) {
  if (typeof value !== 'object' || value === null) return true;
  if (depthLeft === 0) return false;
  return Object.values(value).every((item) => depthWithin(item, depthLeft - 1));
}

// Free-form JSON from AIs and browsers ends up inside a session file: past these bounds it could not be saved.
export function isBoundedJson(value, maxBytes) {
  if (!depthWithin(value, MAX_FREEFORM_DEPTH)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '') <= maxBytes;
  } catch {
    return false;
  }
}

const boundedMessage = (maxBytes) => `must be JSON at most ${MAX_FREEFORM_DEPTH} levels deep and ${maxBytes} bytes long`;

const chat = z.string().optional().describe('Chat id; without it the current chat');
const action = z.object({ id: z.string(), label: z.string(), primary: z.boolean().optional() });

// Raw shapes, because MCP tools take them as they are; HTTP wraps them in z.object.
export const nameShape = { title: z.string().optional(), ai: z.string().optional() };
export const sayShape = {
  text: z.string().max(MAX_TEXT_LENGTH),
  actions: z.array(action).optional(),
  ask: z.record(z.string(), z.unknown()).refine((ask) => isBoundedJson(ask, MAX_ASK_BYTES), boundedMessage(MAX_ASK_BYTES)).optional(),
  files: z.array(z.string()).optional(),
  chat,
};
export const statusShape = {
  state: z.enum(AI_STATES),
  text: z.string().optional().describe(`At most ${MAX_STATUS_TEXT_LENGTH} characters`),
  chat,
};
export const actShape = {
  op: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  tab: z.number().int().nullable().optional().describe('Target tab id, at the top level next to `op`'),
};
export const filePutShape = { name: z.string(), type: z.string().refine(isContentType, 'type must be a plain type/subtype'), base64: z.string() };

// A tab put inside `args` is taken as the target, so it is never silently ignored; a top-level tab wins.
export function actTarget({ op, args = {}, tab }) {
  const { tab: argsTab, ...rest } = args;
  const fallback = Number.isInteger(argsTab) ? argsTab : null;
  return { op, args: Number.isInteger(argsTab) ? rest : args, tab: tab ?? fallback };
}
