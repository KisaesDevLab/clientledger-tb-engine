// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logAiUsage } from '../lib/aiUsage';
import { getLLMProvider } from '../lib/aiClient';
import { TB_TASK_CLASSES } from '../lib/routerProvider';
import { sendServerError } from '../lib/safeError';

export const supportRouter = Router();
supportRouter.use(authMiddleware);

// Load and cache the knowledge base once at process start. The previous
// implementation did 16 sync file reads PER chat request — on a Pi that
// blocks the event loop and stalls other API requests for tens of ms.
let cachedKnowledge: string | null = null;
async function loadKnowledgeBase(): Promise<string> {
  if (cachedKnowledge !== null) return cachedKnowledge;
  const knowledgeDir = process.env.KNOWLEDGE_DIR || path.resolve(__dirname, '../../knowledge');
  let combined = '';
  try {
    const files = (await fs.promises.readdir(knowledgeDir)).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(knowledgeDir, file);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const title = file.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      combined += `\n\n## Knowledge: ${title}\n\n${content}`;
    }
  } catch (err: unknown) {
    console.warn('[support] Knowledge base load failed:', err instanceof Error ? err.message : String(err));
    combined = '(Knowledge base unavailable)';
  }
  cachedKnowledge = combined;
  return combined;
}

// POST /api/v1/support/chat — SSE streaming
supportRouter.post('/chat', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }

  const { conversationId: incomingConvId, message } = req.body as {
    conversationId?: number | null;
    message: string;
  };

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'message is required' } });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const writeEvent = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Determine or create conversation. When resuming, verify the conversation
    // belongs to the requesting user — otherwise any authenticated user could
    // read another user's chat by passing their conversationId.
    let conversationId: number = incomingConvId ?? 0;
    if (incomingConvId) {
      const owned = await db('support_conversations')
        .where({ id: incomingConvId, user_id: userId })
        .first('id');
      if (!owned) {
        writeEvent({ type: 'error', message: 'Conversation not found.' });
        res.end();
        return;
      }
    } else {
      const [newConv] = await db('support_conversations')
        .insert({
          user_id: userId,
          title: message.trim().slice(0, 60),
          is_bookmarked: false,
        })
        .returning('id');
      conversationId = typeof newConv === 'object' && newConv !== null ? (newConv as { id: number }).id : Number(newConv);
    }

    // Emit start event with conversationId
    writeEvent({ type: 'start', conversationId });

    // Load prior messages if resuming a conversation (ownership already verified above)
    type DbMessage = { role: string; content: string };
    const priorMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (incomingConvId) {
      const rows = await db('support_messages')
        .where({ conversation_id: incomingConvId })
        .orderBy('created_at', 'asc')
        .select('role', 'content') as DbMessage[];
      for (const row of rows) {
        priorMessages.push({ role: row.role as 'user' | 'assistant', content: row.content });
      }
    }

    // Load knowledge base
    const knowledge = await loadKnowledgeBase();

    const userRole = req.user?.role ?? 'staff';
    const roleContext =
      userRole === 'admin'
        ? 'The user is an admin — they have full access including user management, tax codes, backup/restore, audit log, period unlocking, and MCP token management.'
        : userRole === 'reviewer'
        ? 'The user is a reviewer — they have read-only access and cannot edit the trial balance, post journal entries, or perform administrative actions.'
        : 'The user is a preparer — they have standard access to all client work including TB editing, journal entries, bank transactions, tax mapping, and reports.';

    const systemPrompt = `You are a helpful support assistant for Vibe Trial Balance, a tax preparation and accounting management suite for small accounting firms. Answer user questions clearly and concisely. Use the knowledge base below to answer questions about features, workflows, and troubleshooting. If you don't know the answer, say so honestly rather than guessing. Tailor your answers to the user's role.

User role: ${userRole}. ${roleContext}

${knowledge}`;

    // Build messages array
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...priorMessages,
      { role: 'user', content: message.trim() },
    ];

    const { provider, primaryModel } = await getLLMProvider();

    // Bail out of the LLM stream the moment the client disconnects. Without
    // this, closing the browser tab kept the Anthropic stream running to
    // completion — racking up token spend and holding pool connections open.
    let clientClosed = false;
    req.on('close', () => { clientClosed = true; });

    // Stream the response
    let fullText = '';
    const streamStarted = Date.now();
    const gen = provider.stream({
      model: primaryModel,
      taskClass: TB_TASK_CLASSES.SUPPORT_CHAT,
      userId: req.user?.userId ?? null,
      // Attribution: the real app role, unlike the prompt-tailoring `userRole`
      // local above whose 'staff' default is not an app role.
      userRole: req.user?.role ?? null,
      maxTokens: 2048,
      system: systemPrompt,
      messages,
    });

    let chunk = await gen.next();
    while (!chunk.done) {
      if (clientClosed) {
        // Best-effort abort: tell the generator to stop. Most providers also
        // honor AbortSignal, but the generic generator contract uses return().
        try { await gen.return?.(undefined as unknown as { inputTokens: number; outputTokens: number }); } catch { /* ignore */ }
        break;
      }
      fullText += chunk.value;
      writeEvent({ type: 'delta', text: chunk.value });
      chunk = await gen.next();
    }

    if (clientClosed) {
      // Don't try to write/flush — socket is gone. We don't have a final
      // usage count when aborted mid-stream, so log zeros so the ledger has a
      // row but the cost tracker doesn't over-attribute.
      logAiUsage({
        endpoint: 'support/chat', model: primaryModel, inputTokens: 0, outputTokens: 0,
        userId: req.user?.userId, clientId: null,
        status: 'error', errorMessage: 'Client disconnected mid-stream',
        durationMs: Date.now() - streamStarted, maxTokens: 2048,
      });
      return;
    }

    // After the while loop exits normally, chunk.done is true and chunk.value
    // is the final LLMUsage payload from the generator's return value.
    if (!chunk.done) {
      // Defensive: shouldn't happen given the loop condition, but keeps the
      // type narrowing honest.
      res.end();
      return;
    }
    const usage = chunk.value;
    logAiUsage({
      endpoint: 'support/chat', model: primaryModel,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      userId: req.user?.userId, clientId: null,
      status: 'success', durationMs: Date.now() - streamStarted, maxTokens: 2048,
    });

    // Save messages to DB in a single transaction so a partial write can't
    // leave the user's message recorded without the assistant reply.
    await db.transaction(async (trx) => {
      await trx('support_messages').insert([
        { conversation_id: conversationId, role: 'user', content: message.trim() },
        { conversation_id: conversationId, role: 'assistant', content: fullText },
      ]);
    });

    writeEvent({ type: 'done', fullText, conversationId });
    res.end();
  } catch (err: unknown) {
    const internal = err instanceof Error ? err.message : String(err);
    console.error('[support]', internal);
    // Record the failure so admins can see it in the AI Usage Log without
    // needing to check server logs. We may not have a primaryModel yet if
    // the failure happened before getLLMProvider returned.
    logAiUsage({
      endpoint: 'support/chat', model: 'unknown',
      inputTokens: 0, outputTokens: 0,
      userId: req.user?.userId, clientId: null,
      status: 'error', errorMessage: internal, maxTokens: 2048,
    });
    writeEvent({ type: 'error', message: 'An internal error occurred. Please try again.' });
    res.end();
  }
});

// GET /api/v1/support/conversations
supportRouter.get('/conversations', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  try {
    const rows = await db('support_conversations as sc')
      .where('sc.user_id', userId)
      .leftJoin('support_messages as sm', 'sm.conversation_id', 'sc.id')
      .select('sc.id', 'sc.title', 'sc.is_bookmarked', 'sc.created_at', 'sc.updated_at')
      .count('sm.id as message_count')
      .groupBy('sc.id', 'sc.title', 'sc.is_bookmarked', 'sc.created_at', 'sc.updated_at')
      .orderBy('sc.updated_at', 'desc');
    res.json({ data: rows, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'support');
  }
});

// GET /api/v1/support/conversations/:id
supportRouter.get('/conversations/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const id = Number(req.params.id);
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  try {
    const conv = await db('support_conversations').where({ id, user_id: userId }).first();
    if (!conv) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }
    const messages = await db('support_messages')
      .where({ conversation_id: id })
      .orderBy('created_at', 'asc')
      .select('id', 'role', 'content', 'created_at');
    res.json({ data: { ...conv, messages }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'support');
  }
});

// PUT /api/v1/support/conversations/:id
supportRouter.put('/conversations/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const id = Number(req.params.id);
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  try {
    const { z } = await import('zod');
    const updateSchema = z.object({
      title: z.string().min(1).max(500).optional(),
      is_bookmarked: z.boolean().optional(),
    });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid input' } });
      return;
    }
    const updates: Record<string, unknown> = { updated_at: db.fn.now() };
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.is_bookmarked !== undefined) updates.is_bookmarked = parsed.data.is_bookmarked;
    const count = await db('support_conversations').where({ id, user_id: userId }).update(updates);
    if (!count) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }
    const conv = await db('support_conversations').where({ id }).first();
    res.json({ data: conv, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'support');
  }
});

// DELETE /api/v1/support/conversations/:id
supportRouter.delete('/conversations/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const id = Number(req.params.id);
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  try {
    const count = await db('support_conversations').where({ id, user_id: userId }).delete();
    if (!count) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }
    res.json({ data: { deleted: true }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'support');
  }
});

// POST /api/v1/support/conversations/:id/bookmark
supportRouter.post('/conversations/:id/bookmark', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const id = Number(req.params.id);
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  try {
    const conv = await db('support_conversations').where({ id, user_id: userId }).first();
    if (!conv) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }
    const newValue = !conv.is_bookmarked;
    await db('support_conversations').where({ id }).update({ is_bookmarked: newValue, updated_at: db.fn.now() });
    res.json({ data: { is_bookmarked: newValue }, error: null });
  } catch (err: unknown) {
    sendServerError(res, err, 'support');
  }
});
