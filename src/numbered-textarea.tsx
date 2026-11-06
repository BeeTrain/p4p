import { createMemo, createSignal, type JSX } from 'solid-js';

type NumberedTextareaProps = {
  id: string;
  value: string;
  rows: number;
  onInput: JSX.EventHandler<HTMLTextAreaElement, InputEvent>;
  'aria-describedby'?: string;
  placeholder?: string;
  maxlength?: number;
  spellcheck?: boolean;
};

export function NumberedTextarea(props: NumberedTextareaProps) {
  const [scrollTop, setScrollTop] = createSignal(0);
  const count = createMemo(() => props.value.split('\n').length);
  const numbers = createMemo(() => Array.from({ length: count() }, (_, index) => index + 1).join('\n'));
  return <div class="p4p-numbered-textarea" style={{ '--p4p-gutter-width': `calc(${Math.max(2, String(count()).length)}ch + 20px)` }}>
    <div class="p4p-line-numbers" aria-hidden="true"><div style={{ transform: `translateY(${-scrollTop()}px)` }}>{numbers()}</div></div>
    <textarea {...props} wrap="off" onScroll={event => setScrollTop(event.currentTarget.scrollTop)} />
  </div>;
}
