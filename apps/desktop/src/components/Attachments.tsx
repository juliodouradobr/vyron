import { useState } from 'react';
import type { Attachment } from '@nexo/protocol';
import { Download, FileText, Film, Music, Play } from 'lucide-react';
import { Button, Modal, Spinner } from './ui';
import { describeError } from '../services/api';
import { fileUrl, formatBytes, useFileUrl } from '../lib/files';

const isImage = (a: Attachment) => a.contentType.startsWith('image/') && a.width && a.height;
const isVideo = (a: Attachment) => a.contentType.startsWith('video/');
const isAudio = (a: Attachment) => a.contentType.startsWith('audio/');

/** Baixar para o computador: o arquivo vem com login e é salvo com o nome original. */
async function saveToDisk(a: Attachment) {
  const url = await fileUrl(a.id);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function DownloadButton({ a, label }: { a: Attachment; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          saveToDisk(a)
            .catch((e) => setError(describeError(e)))
            .finally(() => setBusy(false));
        }}
      >
        <Download size={14} aria-hidden /> {label ?? 'Baixar'}
      </Button>
      {error && <span className="msg__error">{error}</span>}
    </>
  );
}

/** Imagem com o espaço reservado pelas dimensões (a lista não "pula" quando ela carrega). */
function ImageAttachment({ a }: { a: Attachment }) {
  const { url, failed } = useFileUrl(a.id);
  const [open, setOpen] = useState(false);
  const maxW = 400, maxH = 320;
  const scale = Math.min(1, maxW / a.width!, maxH / a.height!);
  const w = Math.max(48, Math.round(a.width! * scale)), h = Math.max(48, Math.round(a.height! * scale));
  return (
    <>
      {/* Proporção reservada (não altura fixa): em telas estreitas a imagem encolhe inteira, sem cortes. */}
      <button className="att-image" style={{ width: w, aspectRatio: `${w} / ${h}` }} onClick={() => url && setOpen(true)} aria-label={`Abrir imagem ${a.filename}`}>
        {url ? <img src={url} alt={a.filename} draggable={false} /> : failed ? <span className="muted">Não foi possível carregar</span> : <Spinner size={18} />}
      </button>
      {open && url && (
        <Modal title={a.filename} onClose={() => setOpen(false)} size="full" footer={<DownloadButton a={a} label={`Baixar (${formatBytes(a.size)})`} />}>
          <div className="att-viewer">
            <img src={url} alt={a.filename} />
          </div>
          <p className="field__hint">
            {a.width}×{a.height} · {formatBytes(a.size)} · metadados de localização e do aparelho foram removidos no envio.
          </p>
        </Modal>
      )}
    </>
  );
}

/** Áudio/vídeo: só baixa quando a pessoa pede para reproduzir (não gasta banda à toa). */
function MediaAttachment({ a }: { a: Attachment }) {
  const [load, setLoad] = useState(false);
  const { url, failed } = useFileUrl(load ? a.id : null);
  const video = isVideo(a);
  return (
    <div className={`att-media ${video ? 'att-media--video' : ''}`}>
      {url ? (
        video ? (
          <video src={url} controls autoPlay playsInline />
        ) : (
          <audio src={url} controls autoPlay />
        )
      ) : (
        <div className="att-file">
          {video ? <Film size={22} aria-hidden /> : <Music size={22} aria-hidden />}
          <span className="att-file__name">
            <strong>{a.filename}</strong>
            <span className="muted">{formatBytes(a.size)}</span>
          </span>
          {failed ? (
            <span className="msg__error">Não foi possível carregar.</span>
          ) : (
            <Button size="sm" onClick={() => setLoad(true)} loading={load}>
              <Play size={14} aria-hidden /> Reproduzir
            </Button>
          )}
          <DownloadButton a={a} />
        </div>
      )}
    </div>
  );
}

function FileAttachment({ a }: { a: Attachment }) {
  return (
    <div className="att-file">
      <FileText size={22} aria-hidden />
      <span className="att-file__name">
        <strong>{a.filename}</strong>
        <span className="muted">{formatBytes(a.size)}</span>
      </span>
      <DownloadButton a={a} />
    </div>
  );
}

export function AttachmentList({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="attachments">
      {items.map((a) =>
        isImage(a) ? <ImageAttachment key={a.id} a={a} /> : isVideo(a) || isAudio(a) ? <MediaAttachment key={a.id} a={a} /> : <FileAttachment key={a.id} a={a} />,
      )}
    </div>
  );
}
