/**
 * A Pipeline board's scroll position, remembered when a card is opened and put
 * back when the board shows again (Back from the record): the board's sideways
 * scroll, each column's own scroll (by stage key) and the page's. Kept per tab
 * (sessionStorage) and per board, and used once — opening the board some other
 * way later starts at the top as usual.
 */
interface BoardScroll { x: number; y: number; page: number; cols: Record<string, number> }

const storageKey = (board: string) => `mh-board-scroll:${board}`;

/** Remember where `root` (the board page) is scrolled. */
export function rememberBoardScroll(board: string, root: HTMLElement | null): void {
  if (!root) return;
  const kanban = root.querySelector<HTMLElement>(".kanban");
  const cols: Record<string, number> = {};
  root.querySelectorAll<HTMLElement>(".kanban-col[data-stage]").forEach((col) => {
    const body = col.querySelector<HTMLElement>(".kanban-col-body");
    if (body && body.scrollTop > 0 && col.dataset.stage) cols[col.dataset.stage] = body.scrollTop;
  });
  const s: BoardScroll = { x: kanban?.scrollLeft ?? 0, y: kanban?.scrollTop ?? 0, page: window.scrollY, cols };
  try { sessionStorage.setItem(storageKey(board), JSON.stringify(s)); } catch { /* storage off: nothing to restore */ }
}

/** Put a remembered position back (once), after the board's rows have rendered. */
export function restoreBoardScroll(board: string, root: HTMLElement | null): void {
  let s: Partial<BoardScroll> | null = null;
  try {
    const raw = sessionStorage.getItem(storageKey(board));
    sessionStorage.removeItem(storageKey(board));
    s = raw ? (JSON.parse(raw) as Partial<BoardScroll>) : null;
  } catch { return; }
  if (!s || !root) return;
  const kanban = root.querySelector<HTMLElement>(".kanban");
  if (kanban) { kanban.scrollLeft = Number(s.x) || 0; kanban.scrollTop = Number(s.y) || 0; }
  root.querySelectorAll<HTMLElement>(".kanban-col[data-stage]").forEach((col) => {
    const top = s!.cols?.[col.dataset.stage ?? ""];
    const body = col.querySelector<HTMLElement>(".kanban-col-body");
    if (body && top) body.scrollTop = top;
  });
  if (Number(s.page) > 0) window.scrollTo(0, Number(s.page));
}
