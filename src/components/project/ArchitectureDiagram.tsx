interface DiagramEdge { from: string; to: string }

function clean(value: string): string {
  return value.trim().replace(/^[A-Za-z0-9_-]+\s*\[\s*["']?/, "").replace(/["']?\s*\]$/, "").trim();
}

export function parseArchitectureEdges(source: string): DiagramEdge[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(.+?)\s*--+>\s*(.+?)\s*$/);
    if (!match) return [];
    const from = clean(match[1]!);
    const to = clean(match[2]!);
    return from && to ? [{ from, to }] : [];
  });
}

export function ArchitectureDiagram({ source }: { source: string }) {
  const edges = parseArchitectureEdges(source);
  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  if (!nodes.length) return <pre className="overflow-auto text-xs leading-6">{source}</pre>;

  const targets = new Set(edges.map((edge) => edge.to));
  const levels = new Map<string, number>();
  const queue = nodes.filter((node) => !targets.has(node));
  for (const root of queue) levels.set(root, 0);
  if (!queue.length) { queue.push(nodes[0]!); levels.set(nodes[0]!, 0); }
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]!;
    const level = levels.get(node) ?? 0;
    for (const edge of edges.filter((item) => item.from === node)) {
      if ((levels.get(edge.to) ?? -1) < level + 1) levels.set(edge.to, level + 1);
      if (!queue.includes(edge.to)) queue.push(edge.to);
    }
  }
  for (const node of nodes) if (!levels.has(node)) levels.set(node, 0);

  const grouped = new Map<number, string[]>();
  for (const node of nodes) {
    const level = levels.get(node) ?? 0;
    grouped.set(level, [...(grouped.get(level) ?? []), node]);
  }
  const maxLevel = Math.max(...grouped.keys());
  const width = 720;
  const nodeWidth = 164;
  const nodeHeight = 52;
  const rowGap = 96;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, row] of grouped) {
    const gap = width / (row.length + 1);
    row.forEach((node, index) => positions.set(node, { x: gap * (index + 1), y: 36 + level * rowGap }));
  }
  const height = Math.max(150, 76 + maxLevel * rowGap);

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-canvas p-3">
      <svg role="img" aria-label="System architecture skeleton diagram" viewBox={`0 0 ${width} ${height}`} className="min-w-[560px]" style={{ width: "100%", height: "auto" }}>
        <defs>
          <marker id="architecture-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 z" fill="#7c8178" />
          </marker>
        </defs>
        {edges.map((edge, index) => {
          const from = positions.get(edge.from)!;
          const to = positions.get(edge.to)!;
          return <path key={`${edge.from}-${edge.to}-${index}`} d={`M ${from.x} ${from.y + nodeHeight / 2} C ${from.x} ${from.y + 65}, ${to.x} ${to.y - 65}, ${to.x} ${to.y - nodeHeight / 2 - 4}`} fill="none" stroke="#a8ada4" strokeWidth="2" markerEnd="url(#architecture-arrow)" />;
        })}
        {nodes.map((node) => {
          const point = positions.get(node)!;
          return <g key={node}>
            <rect x={point.x - nodeWidth / 2} y={point.y - nodeHeight / 2} width={nodeWidth} height={nodeHeight} rx="10" fill="#fff" stroke="#cfd3cc" strokeWidth="1.5" />
            <circle cx={point.x - nodeWidth / 2 + 17} cy={point.y} r="4" fill="#1b5e46" />
            <text x={point.x + 5} y={point.y + 4} textAnchor="middle" fill="#20241f" fontSize="13" fontFamily="IBM Plex Mono, monospace">{node.length > 22 ? `${node.slice(0, 21)}…` : node}</text>
          </g>;
        })}
      </svg>
    </div>
  );
}
