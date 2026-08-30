type RevisionRow = { $id: string; $updatedAt: string };

type RevisionGroup = {
  name: string;
  rows: readonly RevisionRow[];
  total?: number;
};

/**
 * Produces a stable, content-free signal for work that changes the management
 * totals and tables. The newest row detects mobile creates/updates; total also
 * catches removal without sending customer data through the polling signal.
 */
export function liveProgressRevision(groups: readonly RevisionGroup[]) {
  return groups.map(({ name, rows, total = rows.length }) => {
    const latest = rows.reduce<RevisionRow | undefined>((current, row) => {
      if (!current) return row;
      const currentKey = `${current.$updatedAt}:${current.$id}`;
      const rowKey = `${row.$updatedAt}:${row.$id}`;
      return rowKey > currentKey ? row : current;
    }, undefined);
    return `${name}:${total}:${latest?.$updatedAt ?? "-"}:${latest?.$id ?? "-"}`;
  }).join("|");
}
