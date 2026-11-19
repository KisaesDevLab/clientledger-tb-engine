// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// OpenAPI for P10: AI diagnostics for a period and the support chat (a
// conversation streamed as server-sent events, kept, listed, renamed,
// bookmarked and deleted). The routes are upstream's (routes/diagnostics.ts,
// routes/support.ts). Response objects are open: upstream may add columns,
// the desktop reads the fields listed as required.

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const int: Schema = { type: 'integer' };
const str: Schema = { type: 'string' };
const bool: Schema = { type: 'boolean' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const open = (required: string[], properties: Schema, description?: string): Schema => ({
  type: 'object', required, properties, ...(description ? { description } : {}),
});
const json = 'application/json';

function envelope(data: Schema): Schema {
  return { type: 'object', required: ['data', 'error'], properties: { data, error: { type: 'null' } } };
}
const ok = (description: string, data: Schema): Schema => ({
  description, content: { [json]: { schema: envelope(data) } },
});
const err = (description: string): Schema => ({
  description, content: { [json]: { schema: ref('ErrorEnvelope') } },
});
const common: Schema = { '401': err('Missing or wrong desktop session token'), '500': err('Server error (also: no AI set up, or the AI could not be reached)') };
const idParam = (name: string, description: string): Schema => ({
  name, in: 'path', required: true, description, schema: { type: 'integer', minimum: 1 },
});
const jsonBody = (schema: Schema): Schema => ({ required: true, content: { [json]: { schema } } });
const tags = (t: string): string[] => [t];

export const aiSchemas: Record<string, Schema> = {
  Observation: open(['severity', 'category', 'message'], {
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    category: { type: 'string', description: 'A short heading the AI chose, such as Balance Check or Prior Year Variance' },
    message: str,
  }, 'One thing the AI noticed about the period. Advice only: it changes nothing.'),
  Diagnostics: open(['observations', 'periodId'], {
    observations: { type: 'array', items: ref('Observation') },
    periodId: int,
  }),
  ChatRequest: open(['message'], {
    conversationId: { type: ['integer', 'null'], description: 'Carry on this conversation; leave out to start a new one' },
    message: { type: 'string', minLength: 1 },
  }),
  ChatEvent: {
    description: 'One server-sent event of a chat answer, sent as `data: <json>` followed by a blank line. In order: start, then delta as the answer is written, then done; or error at any point (the stream then ends). Nothing is kept until done.',
    oneOf: [
      open(['type', 'conversationId'], { type: { const: 'start' }, conversationId: int }),
      open(['type', 'text'], { type: { const: 'delta' }, text: str }),
      open(['type', 'fullText', 'conversationId'], { type: { const: 'done' }, fullText: str, conversationId: int }),
      open(['type', 'message'], { type: { const: 'error' }, message: str }),
    ],
  },
  Conversation: open(['id', 'title', 'is_bookmarked', 'created_at', 'updated_at'], {
    id: int, title: str, is_bookmarked: bool, created_at: dateTime, updated_at: dateTime,
    user_id: int,
    message_count: { type: ['integer', 'string'], description: 'How many messages (text from some drivers)' },
  }),
  ChatMessage: open(['id', 'role', 'content', 'created_at'], {
    id: int, role: { type: 'string', enum: ['user', 'assistant'] }, content: str, created_at: dateTime,
  }),
  ConversationWithMessages: {
    allOf: [ref('Conversation'), open(['messages'], { messages: { type: 'array', items: ref('ChatMessage') } })],
  },
  ConversationUpdate: open([], {
    title: { type: 'string', minLength: 1, maxLength: 500 },
    is_bookmarked: bool,
  }),
};

const periodParam = idParam('periodId', 'Period id');
const convParam = idParam('id', 'Conversation id');

export const aiPaths: Record<string, Schema> = {
  '/api/v1/periods/{periodId}/diagnostics': {
    parameters: [periodParam],
    post: {
      operationId: 'runDiagnostics', tags: tags('ai'),
      summary: 'Ask the AI to review the period: balance, large changes from the prior year, unusual balances, unclassified bank rows',
      responses: {
        '200': ok('What the AI noticed', ref('Diagnostics')),
        '400': err('INVALID_ID'),
        '404': err('NOT_FOUND: no such period'),
        '502': err('AI_PARSE_ERROR: the AI answered in a form that could not be read'),
        ...common,
      },
    },
  },
  '/api/v1/support/chat': {
    post: {
      operationId: 'supportChat', tags: tags('ai'),
      summary: 'Ask the support assistant; the answer streams back as server-sent events',
      requestBody: jsonBody(ref('ChatRequest')),
      responses: {
        '200': {
          description: 'The answer as it is written (see ChatEvent). An AI failure arrives as an error event, not a status.',
          content: { 'text/event-stream': { schema: ref('ChatEvent') } },
        },
        '400': err('INVALID_INPUT: no message'),
        '401': err('Missing or wrong desktop session token'),
      },
    },
  },
  '/api/v1/support/conversations': {
    get: {
      operationId: 'listConversations', tags: tags('ai'), summary: 'Earlier conversations, newest first',
      responses: { '200': ok('The conversations', { type: 'array', items: ref('Conversation') }), ...common },
    },
  },
  '/api/v1/support/conversations/{id}': {
    parameters: [convParam],
    get: {
      operationId: 'getConversation', tags: tags('ai'), summary: 'A conversation and its messages, oldest first',
      responses: { '200': ok('The conversation', ref('ConversationWithMessages')), '404': err('NOT_FOUND'), ...common },
    },
    put: {
      operationId: 'updateConversation', tags: tags('ai'), summary: 'Rename a conversation or bookmark it',
      requestBody: jsonBody(ref('ConversationUpdate')),
      responses: { '200': ok('Changed', ref('Conversation')), '400': err('VALIDATION_ERROR'), '404': err('NOT_FOUND'), ...common },
    },
    delete: {
      operationId: 'deleteConversation', tags: tags('ai'), summary: 'Delete a conversation and its messages',
      responses: { '200': ok('Deleted', open(['deleted'], { deleted: { const: true } })), '404': err('NOT_FOUND'), ...common },
    },
  },
  '/api/v1/support/conversations/{id}/bookmark': {
    parameters: [convParam],
    post: {
      operationId: 'toggleConversationBookmark', tags: tags('ai'), summary: 'Bookmark a conversation, or take the bookmark off',
      responses: { '200': ok('The bookmark now', open(['is_bookmarked'], { is_bookmarked: bool })), '404': err('NOT_FOUND'), ...common },
    },
  },
};
