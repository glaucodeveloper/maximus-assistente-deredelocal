export function component(Component, props) {
  const context = {};
  const iterator = Component.call(context, props);

  context.next = iterator.next.bind(iterator);
  context.return = iterator.return.bind(iterator);
  context.throw = iterator.throw.bind(iterator);

  return context;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function safeId(value, fallback = 'component') {
  const id = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return id || fallback;
}
