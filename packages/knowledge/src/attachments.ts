import { stableId, type AttachmentStructuredContext } from "@client/shared";
import { runSql } from "./postgres-client.js";

export type { AttachmentStructuredContext };

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
  created_at: Date;
}

export interface SaveChatAttachmentInput {
  conversationId: string;
  projectRootPath: string;
  turnIndex: number;
  mimeType: string;
  imageData: Buffer;
  ocrText: string;
  structuredContext: AttachmentStructuredContext;
  visionModel: string;
}

/** Fire-and-forget-adjacent (2026-07-19): unlike upsertBusinessGraphEntry this DOES throw on failure - an attachment the user just uploaded silently vanishing is worse than a visible error, unlike a background Observer crawl's summary. */
export async function saveChatAttachment(input: SaveChatAttachmentInput): Promise<string> {
  const id = stableId(["chat-attachment", input.conversationId, input.turnIndex, Date.now()]);
  const now = new Date().toISOString();

  await runSql(
    `
      insert into chat_attachments
        (id, conversation_id, project_root_path, turn_index, mime_type, file_size_bytes, image_data, ocr_text, structured_context, vision_model, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
    `,
    [
      id,
      input.conversationId,
      input.projectRootPath,
      input.turnIndex,
      input.mimeType,
      input.imageData.byteLength,
      input.imageData,
      input.ocrText,
      JSON.stringify(input.structuredContext),
      input.visionModel,
      now,
    ],
  );

  return id;
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
 * linkChatAttachmentsToTurn below - attachments are uploaded and analyzed
 * BEFORE the user hits send, while conversationId/turnIndex are still
 * unknown). No image bytes, same reasoning as loadChatAttachmentsForConversation.
 */
export async function loadChatAttachmentsByIds(ids: string[]): Promise<ChatAttachmentRecord[]> {
  if (ids.length === 0) {
    return [];
  }

  const rows = await runSql<ChatAttachmentRow>(
    `
      select id, conversation_id, project_root_path, turn_index, mime_type, file_size_bytes, ocr_text, structured_context, vision_model, created_at
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
      select id, conversation_id, project_root_path, turn_index, mime_type, file_size_bytes, ocr_text, structured_context, vision_model, created_at
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
    createdAt: new Date(row.created_at).toISOString(),
  };
}
