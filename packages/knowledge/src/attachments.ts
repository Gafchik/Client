import { stableId, type AttachmentStructuredContext } from "@client/shared";
import { runSql } from "./postgres-client.js";

export type { AttachmentStructuredContext };

export type ChatAttachmentAnalysisStatus = "pending" | "ready";

export interface ChatAttachmentRecord {
  id: string;
  conversationId: string;
  projectRootPath: string;
  turnIndex: number;
  mimeType: string;
  fileSizeBytes: number;
  ocrText: string;
  structuredContext: AttachmentStructuredContext;
  visionModel: string;
  /** "pending" until the background Vision Analyzer pass (see completeChatAttachmentAnalysis) finishes - see createPendingChatAttachment's docstring for why this exists. */
  analysisStatus: ChatAttachmentAnalysisStatus;
  createdAt: string;
}

interface ChatAttachmentRow {
  id: string;
  conversation_id: string;
  project_root_path: string;
  turn_index: number;
  mime_type: string;
  file_size_bytes: number;
  ocr_text: string;
  structured_context: AttachmentStructuredContext;
  vision_model: string;
  analysis_status: ChatAttachmentAnalysisStatus;
  created_at: Date;
}

export interface CreatePendingChatAttachmentInput {
  conversationId: string;
  projectRootPath: string;
  turnIndex: number;
  mimeType: string;
  imageData: Buffer;
}

/**
 * Saves raw image bytes immediately, WITHOUT waiting on the Vision Analyzer
 * (2026-07-31 fix, product-owner request: "картинка должна разбираться
 * после отправки, а не до"). Before this, the app.ts endpoint ran the full
 * two-pass vision analysis (15-45s live) BEFORE ever returning an id, which
 * the web client then awaited BEFORE dispatching /api/pipeline/run - so
 * pressing Send visibly did nothing until vision analysis finished, even
 * though the analysis result isn't needed until the pipeline actually builds
 * its context hint (buildAttachmentContextHint, apps/api's pipeline-runner.ts)
 * well into the run. Row starts `analysis_status = 'pending'`, empty
 * ocr_text/structured_context/vision_model - the caller (app.ts) kicks off
 * the real analysis in the background right after this returns and calls
 * completeChatAttachmentAnalysis when it's done. A screenshot pasted and
 * never sent (abandoned draft) simply stays pending forever, same "orphaned
 * draft" tradeoff linkChatAttachmentsToTurn below already makes.
 */
export async function createPendingChatAttachment(input: CreatePendingChatAttachmentInput): Promise<string> {
  const id = stableId(["chat-attachment", input.conversationId, input.turnIndex, Date.now()]);
  const now = new Date().toISOString();

  await runSql(
    `
      insert into chat_attachments
        (id, conversation_id, project_root_path, turn_index, mime_type, file_size_bytes, image_data, analysis_status, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
    `,
    [
      id,
      input.conversationId,
      input.projectRootPath,
      input.turnIndex,
      input.mimeType,
      input.imageData.byteLength,
      input.imageData,
      now,
    ],
  );

  return id;
}

export interface CompleteChatAttachmentAnalysisInput {
  ocrText: string;
  structuredContext: AttachmentStructuredContext;
  visionModel: string;
}

/** Fills in the Vision Analyzer's result once the background pass (kicked off right after createPendingChatAttachment) finishes, and flips analysis_status to 'ready'. Best-effort - a write failure here just leaves the attachment permanently pending (degrades to "no image context," same as any other memory channel's graceful-degradation convention), never throws into the caller's background task. */
export async function completeChatAttachmentAnalysis(id: string, input: CompleteChatAttachmentAnalysisInput): Promise<void> {
  try {
    await runSql(
      `update chat_attachments set ocr_text = $2, structured_context = $3::jsonb, vision_model = $4, analysis_status = 'ready' where id = $1`,
      [id, input.ocrText, JSON.stringify(input.structuredContext), input.visionModel],
    );
  } catch (error) {
    console.warn("[attachments] completeChatAttachmentAnalysis failed:", error);
  }
}

/** Full record INCLUDING image bytes - only for the single-attachment "view/download" endpoint, never for bulk context loading (see loadChatAttachmentsForConversation). */
export async function loadChatAttachmentWithImage(id: string): Promise<(ChatAttachmentRecord & { imageData: Buffer }) | null> {
  const rows = await runSql<ChatAttachmentRow & { image_data: Buffer }>(
    `select * from chat_attachments where id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? { ...mapAttachmentRow(row), imageData: row.image_data } : null;
}

/**
 * By explicit ID list, NOT by conversation (2026-07-19) - this is what
 * pipeline-runner.ts's buildAttachmentContextHint uses: the chat request
 * already names exactly which attachments belong to THIS turn
 * (PipelineExecutionRequest.attachmentIds), so there's no need to guess by
 * conversation/turn_index, which may not even be linked yet (see
 * linkChatAttachmentsToTurn below - the row is created and Send is
 * dispatched while conversationId/turnIndex are still unknown, see
 * createPendingChatAttachment). No image bytes, same reasoning as
 * loadChatAttachmentsForConversation. Callers that need the Vision
 * Analyzer's result should go through pipeline-runner.ts's
 * buildAttachmentContextHint, which polls this until analysisStatus flips
 * to 'ready' rather than reading a possibly-still-'pending' row directly.
 */
export async function loadChatAttachmentsByIds(ids: string[]): Promise<ChatAttachmentRecord[]> {
  if (ids.length === 0) {
    return [];
  }

  const rows = await runSql<ChatAttachmentRow>(
    `
      select id, conversation_id, project_root_path, turn_index, mime_type, file_size_bytes, ocr_text, structured_context, vision_model, analysis_status, created_at
      from chat_attachments
      where id = any($1::text[])
    `,
    [ids],
  );

  return rows.map(mapAttachmentRow);
}

/**
 * Backfills conversation_id/turn_index once the message the attachment was
 * pasted into is actually sent (2026-07-19) - an upload happens the moment
 * the user pastes an image, well before conversationId/turnIndex exist (a
 * brand new chat's conversationId is only minted when the first message is
 * actually submitted, see pipeline-runner.ts). Rows start with
 * conversation_id = "" / turn_index = 0 at upload time and get linked here;
 * an attachment pasted but never sent (abandoned draft) simply stays
 * unlinked, the same "orphaned draft" tradeoff any chat app makes.
 */
export async function linkChatAttachmentsToTurn(attachmentIds: string[], conversationId: string, turnIndex: number): Promise<void> {
  if (attachmentIds.length === 0) {
    return;
  }

  await runSql(
    `update chat_attachments set conversation_id = $1, turn_index = $2 where id = any($3::text[])`,
    [conversationId, turnIndex, attachmentIds],
  );
}

/**
 * Metadata + structured context only, NO image bytes (2026-07-19) - this is
 * what feeds follow-up-turn context (see pipeline-runner.ts's
 * buildAttachmentContextHint) and the chat history list; loading raw image
 * bytes for every attachment of a long conversation on every subsequent
 * question would be real, avoidable cost (both DB transfer and prompt
 * tokens neither the Researcher nor the UI list view actually needs).
 */
export async function loadChatAttachmentsForConversation(conversationId: string): Promise<ChatAttachmentRecord[]> {
  const rows = await runSql<ChatAttachmentRow>(
    `
      select id, conversation_id, project_root_path, turn_index, mime_type, file_size_bytes, ocr_text, structured_context, vision_model, analysis_status, created_at
      from chat_attachments
      where conversation_id = $1
      order by turn_index asc, created_at asc
    `,
    [conversationId],
  );

  return rows.map(mapAttachmentRow);
}

/** Same reasoning as facts.ts's deleteFactsForPath - a project path being removed/forgotten must not leave orphaned attachment rows (and their image bytes) behind forever. */
export async function deleteChatAttachmentsForPath(projectRootPath: string): Promise<void> {
  try {
    await runSql(`delete from chat_attachments where project_root_path = $1`, [projectRootPath]);
  } catch (error) {
    console.warn("[attachments] deleteChatAttachmentsForPath failed:", error);
  }
}

export async function deleteChatAttachmentsForRuns(projectRootPath: string, runIds: string[]): Promise<void> {
  const ids = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];

  if (ids.length === 0) {
    return;
  }

  try {
    const rows = await runSql<{ conversation_id: string; turn_index: number }>(
      `
        select conversation_id, turn_index
        from knowledge_catalog
        where project_root_path = $1 and run_id = any($2::text[])
      `,
      [projectRootPath, ids],
    );

    if (rows.length === 0) {
      return;
    }

    const conversationIds = [...new Set(rows.map((row) => row.conversation_id).filter(Boolean))];
    const turnIndexes = [...new Set(rows.map((row) => row.turn_index).filter((value) => Number.isFinite(value)))];

    if (conversationIds.length === 0 || turnIndexes.length === 0) {
      return;
    }

    await runSql(
      `
        delete from chat_attachments
        where project_root_path = $1
          and conversation_id = any($2::text[])
          and turn_index = any($3::int[])
      `,
      [projectRootPath, conversationIds, turnIndexes],
    );
  } catch (error) {
    console.warn("[attachments] deleteChatAttachmentsForRuns failed:", error);
  }
}

function mapAttachmentRow(row: ChatAttachmentRow): ChatAttachmentRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectRootPath: row.project_root_path,
    turnIndex: row.turn_index,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    ocrText: row.ocr_text,
    structuredContext: row.structured_context,
    visionModel: row.vision_model,
    analysisStatus: row.analysis_status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
