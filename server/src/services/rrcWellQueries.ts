/**
 * Read side of the RRC refresh for one Texas well: its deviated wellbores
 * (bottom hole + approximate path), its status history and the RRC files —
 * with their snapshot dates — its values came from. Shared by the map panel
 * (/gis/wells/:fid) and Well Analysis (/wells/:id/dossier). Only called once
 * services/rrcRefresh has created these tables (rrcRefreshAvailable()).
 */
import { prisma } from "../db.js";

export interface WellBoreDetail {
  fid: number;
  profile: string | null;
  stcode: string | null;
  api: string | null;
  status: string | null;
  statusDetail: string | null;
  bottomHole: [number, number] | null;
  /** Straight-line surface → bottom-hole distance (ft). */
  offsetFt: number | null;
  approximate: boolean;
  bhSource: string | null;
  lineSource: string | null;
  geomFlag: string | null;
  /** Not yet completed: the bottom hole is RRC's permitted target, not a drilled location. */
  planned: boolean;
}

export interface WellHistoryEvent { date: string | null; event: string; status: string | null; detail: string | null; source: string }
export interface WellSource { id: string; name: string | null; file: string | null; asOf: string | null }

export const WELL_BORES_SQL = `
  SELECT fid, wellbore_type AS profile, stcode, api10 AS api, status, status_detail AS "statusDetail",
         CASE WHEN bh_geom IS NOT NULL THEN json_build_array(ST_X(bh_geom), ST_Y(bh_geom)) END AS "bottomHole",
         round(ST_Length(geom::geography) * 3.28084)::int AS "offsetFt",
         coalesce(approximate, true) AS approximate, bh_source AS "bhSource", line_source AS "lineSource", geom_flag AS "geomFlag",
         coalesce(bh_planned, false) AS planned
    FROM rrc.wellbores WHERE surface_fid = $1 ORDER BY fid`;

export const WELL_HISTORY_SQL = `
  SELECT to_char(event_date, 'YYYY-MM-DD') AS date, event, status, detail, source
    FROM rrc.well_status_history WHERE fid = $1
   ORDER BY event_date NULLS FIRST, CASE event WHEN 'previous-status' THEN 0 WHEN 'status-refresh' THEN 2 ELSE 1 END, recorded_at`;

/** The newest snapshot row per source id (each refresh records its files). */
export const WELL_SOURCES_SQL = `
  SELECT DISTINCT ON (id) id, name, file, to_char(as_of, 'YYYY-MM-DD') AS "asOf"
    FROM rrc.source_snapshot ORDER BY id, loaded_at DESC`;

export async function rrcWellRefreshDetail(fid: number): Promise<{ bores: WellBoreDetail[]; history: WellHistoryEvent[]; sourceFiles: WellSource[] }> {
  const [bores, history, sourceFiles] = await Promise.all([
    prisma.$queryRawUnsafe<WellBoreDetail[]>(WELL_BORES_SQL, fid),
    prisma.$queryRawUnsafe<WellHistoryEvent[]>(WELL_HISTORY_SQL, fid),
    prisma.$queryRawUnsafe<WellSource[]>(WELL_SOURCES_SQL),
  ]);
  return { bores, history, sourceFiles };
}
