const TABLE_CAPTIONS = new Map([
  ['model|harness|index|$ / task|$ / solved task', 'Measured model and harness results, including cost per task and cost per solved task.'],
  ['model|source|pass|age|light|moderate|heavy', 'Modelled cost per solved task by benchmark source, pass rate, age and workload tier.'],
  ['variant|formula', 'Retry-cost calculation variants and their formulas.'],
  ['parameter|value|provenance', 'Cost-model assumptions, values and provenance.'],
  ['source|tasks|covers 2026 models|publishes cost|newest entry', 'Research sources, coverage, cost publication and newest available entry.'],
]);

const normalized = (value) => value.replace(/\s+/g, ' ').trim();

function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text' && typeof node.value === 'string') return node.value;
  return Array.isArray(node.children) ? node.children.map(nodeText).join('') : '';
}

function tableHeaders(table) {
  const thead = table.children?.find((node) => node?.type === 'element' && node.tagName === 'thead');
  const row = thead?.children?.find((node) => node?.type === 'element' && node.tagName === 'tr');
  return (row?.children ?? [])
    .filter((node) => node?.type === 'element' && (node.tagName === 'th' || node.tagName === 'td'))
    .map((node) => normalized(nodeText(node)))
    .filter(Boolean);
}

export function accessibleTableCaption(headers) {
  const labels = headers.map(normalized).filter(Boolean);
  const key = labels.map((label) => label.toLowerCase()).join('|');
  return TABLE_CAPTIONS.get(key) ?? (labels.length
    ? `Data table with columns: ${labels.join(', ')}.`
    : 'Data table from this research note.');
}

/**
 * Give every Markdown-generated data table a build-time accessible name.
 * Existing authored captions win, so the transform is safe and idempotent.
 */
export function rehypeAccessibleTableCaptions() {
  return (tree) => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'element' && node.tagName === 'table') {
        const children = Array.isArray(node.children) ? node.children : (node.children = []);
        const alreadyCaptioned = children.some((child) => child?.type === 'element' && child.tagName === 'caption');
        if (!alreadyCaptioned) {
          children.unshift({
            type: 'element',
            tagName: 'caption',
            properties: { className: ['sr-only'] },
            children: [{ type: 'text', value: accessibleTableCaption(tableHeaders(node)) }],
          });
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

export default rehypeAccessibleTableCaptions;
