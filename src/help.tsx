import { createSignal, createUniqueId } from 'solid-js';

export function Info(props: { label: string; text: string; id?: string }) {
  const uid = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const id = () => props.id ?? `${uid}-help`;
  return <span class="p4p-help" onMouseEnter={() => setOpen(true)} onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }} onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button class="p4p-info" type="button" aria-label={`О разделе «${props.label}»`} aria-describedby={id()} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>i</button>
    <span id={id()} role="tooltip" class="p4p-tooltip" hidden={!open()}>{props.text}</span>
  </span>;
}

export function SectionHeading(props: { title: string; help: string; helpId?: string }) {
  return <div class="p4p-section-title"><h2>{props.title}</h2><Info label={props.title} text={props.help} id={props.helpId} /></div>;
}
