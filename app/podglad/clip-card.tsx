'use client';

import { useRef, useState } from 'react';

export interface ClipView {
  id: string;
  videoUrl: string | null;
  hook: string | null;
  caption: string | null;
  hashtags: string[];
  durationSeconds: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
  sourceTitle: string | null;
  sourceHandle: string | null;
  sourceUrl: string | null;
  status: string;
  scheduledFor: string | null;
  accountHandle: string | null;
}

export function ClipCard({ clip }: { clip: ClipView }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  function toggle() {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      // Only one clip should ever be audible.
      document.querySelectorAll('video').forEach((other) => {
        if (other !== el) other.pause();
      });
      void el.play();
    } else {
      el.pause();
    }
  }

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-[9/16] bg-black">
        {clip.videoUrl ? (
          <>
            <video
              ref={video}
              src={clip.videoUrl}
              className="h-full w-full object-contain"
              playsInline
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={toggle}
            />
            {!playing && (
              <button
                type="button"
                onClick={toggle}
                aria-label="Odtwórz"
                className="absolute inset-0 flex items-center justify-center bg-black/20 transition hover:bg-black/10"
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 text-2xl text-black">
                  ▶
                </span>
              </button>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
            Plik usunięty przez retencję — wpis został, nagranie nie
          </div>
        )}

        <span className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">
          {formatDuration(clip.durationSeconds)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium">@{clip.accountHandle ?? '—'}</span>
          <StatusBadge status={clip.status} scheduledFor={clip.scheduledFor} />
        </div>

        {clip.hook && <p className="text-sm leading-snug font-medium">{clip.hook}</p>}

        {clip.caption && (
          <p className="text-sm whitespace-pre-line text-muted">{clip.caption}</p>
        )}

        {clip.hashtags.length > 0 && (
          <p className="text-xs leading-relaxed text-muted">
            {clip.hashtags.map((h) => `#${h}`).join(' ')}
          </p>
        )}

        <footer className="mt-auto border-t border-border pt-2 text-xs text-muted">
          {clip.startSeconds !== null && (
            <span className="tabular-nums">
              {formatClock(clip.startSeconds)}–{formatClock(clip.endSeconds ?? 0)}
              {' · '}
            </span>
          )}
          {clip.sourceUrl ? (
            <a
              href={sourceLinkWithTime(clip.sourceUrl, clip.startSeconds)}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:no-underline"
            >
              {clip.sourceHandle ?? 'źródło'}
            </a>
          ) : (
            (clip.sourceHandle ?? '—')
          )}
          {clip.sourceTitle && (
            <span className="block truncate">{clip.sourceTitle}</span>
          )}
        </footer>
      </div>
    </article>
  );
}

function StatusBadge({
  status,
  scheduledFor,
}: {
  status: string;
  scheduledFor: string | null;
}) {
  const label =
    status === 'skipped_shadow'
      ? 'tryb próbny'
      : status === 'scheduled'
        ? `plan ${formatWhen(scheduledFor)}`
        : status === 'published'
          ? 'opublikowane'
          : status === 'failed'
            ? 'błąd'
            : status;

  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted">
      {label}
    </span>
  );
}

/** Deep-links to the exact moment in the source video. */
function sourceLinkWithTime(url: string, startSeconds: number | null): string {
  if (startSeconds === null || !url.includes('youtube.com')) return url;
  return `${url}&t=${Math.floor(startSeconds)}s`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  return `${Math.round(seconds)}s`;
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatWhen(value: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleString('pl', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
