import { randomUUID } from "node:crypto";
import type { TeamRecord } from "@client/shared";
import { runSql, withTransaction } from "./postgres-client.js";

export interface SaveTeamInput {
  id?: string;
  name: string;
  researcherModel: string;
  criticModel: string;
  observerModel: string;
  developerModel?: string;
  reviewerModel?: string;
  researcherEscalationModel?: string;
  visionModel?: string;
  isSelected?: boolean;
}

interface TeamRow {
  id: string;
  name: string;
  researcher_model: string;
  critic_model: string;
  observer_model: string;
  developer_model: string;
  reviewer_model: string;
  researcher_escalation_model: string | null;
  vision_model: string | null;
  is_selected: boolean;
  created_at: Date;
  updated_at: Date;
}

// Проверенная вживую тройка (2026-07-14/15): gpt-5.4-mini — единственная
// модель, ни разу не давшая уверенный неверный ответ под критиком;
// gemini-3.1-flash-lite — кросс-вендорный критик (см.
// docs/architecture/009, Evidence Validator/Critic); nemotron-3-ultra —
// бесплатный, но не самостоятельно останавливающийся observer, поэтому
// только для фонового обхода с конечным объёмом работы, не для чата.
const DEFAULT_TEAM_ID = "team-default-researched-trio";
const DEFAULT_RESEARCHER_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_CRITIC_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_OBSERVER_MODEL = "nvidia/nemotron-3-ultra";
// Reviewer по умолчанию — НЕ критик (2026-07-17, живое свидетельство: на
// первом же E2E develop-ране flash-lite-критик в роли ревьюера выдал
// фактически неверный finding — «один восклицательный знак» при двух прямо в
// предъявленном ему журнале верификации). Kimi K2.7 Code — единственная
// code-специализированная модель среднего ценового диапазона каталога (009,
// принцип 5); ревью — редкий вызов change-flow, 1.6x здесь допустимо (009
// §12.1). Это ДЕФОЛТ для команд, где роль не задана явно — сама модель
// живёт в Postgres и меняется с фронта, как и остальные роли.
const DEFAULT_REVIEWER_MODEL = "moonshotai/kimi-k2.7-code";

export async function initializeTeamStore(): Promise<void> {
  // Таблица создаётся централизованно в initializePostgresSchema() (postgres-client.ts).
  await ensureDefaultTeam();
}

export async function listTeams(): Promise<TeamRecord[]> {
  const rows = await runSql<TeamRow>(`select * from teams order by is_selected desc, updated_at desc`);
  return rows.map(mapTeamRow);
}

export async function getSelectedTeam(): Promise<TeamRecord | null> {
  const rows = await runSql<TeamRow>(`select * from teams where is_selected = true order by updated_at desc limit 1`);
  const row = rows[0];
  return row ? mapTeamRow(row) : null;
}

export async function getTeamById(id: string): Promise<TeamRecord | null> {
  const rows = await runSql<TeamRow>(`select * from teams where id = $1 limit 1`, [id]);
  const row = rows[0];
  return row ? mapTeamRow(row) : null;
}

export async function saveTeam(input: SaveTeamInput): Promise<TeamRecord> {
  const nextId = input.id?.trim() || `team-${randomUUID()}`;
  const shouldBeSelected = input.isSelected ?? false;
  const now = new Date().toISOString();

  await withTransaction(async (client) => {
    if (shouldBeSelected) {
      await client.query(`update teams set is_selected = false, updated_at = $1 where is_selected = true`, [now]);
    }

    await client.query(
      `
        insert into teams (id, name, researcher_model, critic_model, observer_model, developer_model, reviewer_model, researcher_escalation_model, vision_model, is_selected, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
        on conflict (id) do update set
          name = $2,
          researcher_model = $3,
          critic_model = $4,
          observer_model = $5,
          developer_model = $6,
          reviewer_model = $7,
          researcher_escalation_model = $8,
          vision_model = $9,
          is_selected = $10,
          updated_at = $11
      `,
      [
        nextId,
        input.name.trim(),
        input.researcherModel.trim(),
        input.criticModel.trim(),
        input.observerModel.trim(),
        input.developerModel?.trim() ?? "",
        input.reviewerModel?.trim() ?? "",
        input.researcherEscalationModel?.trim() || null,
        input.visionModel?.trim() || null,
        shouldBeSelected,
        now,
      ],
    );
  });

  const saved = await getTeamById(nextId);

  if (!saved) {
    throw new Error("Не удалось загрузить команду после сохранения.");
  }

  return saved;
}

export async function setSelectedTeam(id: string): Promise<TeamRecord | null> {
  const existing = await getTeamById(id);

  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();

  await withTransaction(async (client) => {
    await client.query(`update teams set is_selected = false, updated_at = $1 where is_selected = true`, [now]);
    await client.query(`update teams set is_selected = true, updated_at = $1 where id = $2`, [now, id]);
  });

  return getTeamById(id);
}

export async function deleteTeam(id: string): Promise<boolean> {
  const existing = await getTeamById(id);

  if (!existing) {
    return false;
  }

  await runSql(`delete from teams where id = $1`, [id]);

  if (existing.isSelected) {
    const now = new Date().toISOString();
    const fallbackRows = await runSql<{ id: string }>(`select id from teams order by updated_at desc limit 1`);
    const fallbackId = fallbackRows[0]?.id;

    if (fallbackId) {
      await runSql(`update teams set is_selected = true, updated_at = $1 where id = $2`, [now, fallbackId]);
    }
  }

  return true;
}

async function ensureDefaultTeam(): Promise<void> {
  const countRows = await runSql<{ count: string }>(`select count(*)::text as count from teams`);
  const count = Number(countRows[0]?.count ?? 0);

  if (count > 0) {
    return;
  }

  await saveTeam({
    id: DEFAULT_TEAM_ID,
    name: "Проверенная тройка",
    researcherModel: DEFAULT_RESEARCHER_MODEL,
    criticModel: DEFAULT_CRITIC_MODEL,
    observerModel: DEFAULT_OBSERVER_MODEL,
    reviewerModel: DEFAULT_REVIEWER_MODEL,
    isSelected: true,
  });
}

function mapTeamRow(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    researcherModel: row.researcher_model,
    criticModel: row.critic_model,
    observerModel: row.observer_model,
    // Fallback-политика для команд, где develop-роли не заданы явно:
    // Developer = Researcher (тот же агентный архетип «исследует и делает»),
    // Reviewer = code-специализированный дефолт, НЕ критик (см. константу).
    // UI показывает эти же effective-значения, так что пользователь всегда
    // видит, какая модель реально пойдёт в работу.
    developerModel: row.developer_model || row.researcher_model,
    reviewerModel: row.reviewer_model || DEFAULT_REVIEWER_MODEL,
    ...(row.researcher_escalation_model ? { researcherEscalationModel: row.researcher_escalation_model } : {}),
    ...(row.vision_model ? { visionModel: row.vision_model } : {}),
    isSelected: Boolean(row.is_selected),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
