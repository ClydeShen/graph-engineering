'use client';

/**
 * Review — the human-in-the-loop triage surface (GH #34, write-half of /memory).
 *
 * The metabolism (#32) retires what is provably bad and keeps what is provably
 * good on its own; the AMBIGUOUS middle is never decided silently — it surfaces
 * here, each with its success-rate, for the human to judge. Actions are natural
 * (Keep / Needs work / Retire), never a typed number, and flow back as clean
 * human-localised attribution. No-action is safe: the item simply waits.
 *
 * Design (ui-ux-pro-max): success-rate is the decision signal, so it leads each
 * card as a tabular figure + bar. One primary CTA (Keep); Retire is destructive,
 * so it is danger-toned, spatially separated, and asks for an inline confirm
 * (the delete is reversible, so a full modal would be heavier than the act).
 * Actions remove the card optimistically and restore it on error. Text is
 * left-aligned throughout.
 */

import { useEffect, useState } from 'react';
import { api, type TriageCandidate } from '@/lib/api';
import { Badge, Button, Icon, Panel, Tag } from '@/components/ds';

type Action = 'success' | 'failure' | 'retire';

function rateTone(rate: number): 'ok' | 'info' | 'neutral' {
  if (rate >= 0.6) return 'ok';
  if (rate >= 0.4) return 'info';
  return 'neutral';
}

/** The learned ordering constraints in the lesson — the "key steps" to verify. */
function constraintLines(content: string | null): string[] {
  if (!content) return [];
  return content
    .split(/[;.\n]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && (/\bbefore\b/i.test(c) || /->|→/.test(c)));
}

export default function ReviewPage() {
  const [items, setItems] = useState<TriageCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .triage()
      .then((r) => setItems(r.triage))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'));
  }, []);

  async function act(item: TriageCandidate, action: Action): Promise<void> {
    if (busy !== null) return;
    setBusy(item.id);
    setNote(null);
    const prev = items ?? [];
    setItems(prev.filter((i) => i.id !== item.id)); // optimistic removal
    try {
      if (action === 'retire') await api.triageRetire(item.id);
      else await api.triageFeedback(item.id, action);
      const verb = action === 'retire' ? 'Retired' : action === 'success' ? 'Kept' : 'Marked for rework';
      setNote(`${verb}: ${item.intent_description ?? 'procedure'}`);
    } catch (e: unknown) {
      setItems(prev); // restore on failure
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(null);
      setConfirmRetire(null);
    }
  }

  if (error !== null) return <Badge tone="danger">{error}</Badge>;
  if (items === null) return <p className="ds-label">loading what needs your review…</p>;

  if (items.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', maxWidth: 820 }}>
        {note !== null ? <Badge tone="ok" dot>{note}</Badge> : null}
        <Panel variant="sunken">
          <p style={{ margin: 0, textAlign: 'left', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Nothing needs your review. The system retires what proves unreliable and keeps
            what proves dependable on its own — only the genuinely uncertain procedures land
            here, and right now there are none.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', maxWidth: 820 }}>
      <p style={{ margin: 0, textAlign: 'left', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        These recalled procedures are working sometimes and failing other times — the system
        can&apos;t tell on its own whether they are worth keeping. Your call teaches it.
      </p>
      {note !== null ? <Badge tone="ok" dot>{note}</Badge> : null}

      {items.map((item) => {
        const rate = Math.round(item.quality_score * 100);
        const runs = item.success_count + item.failure_count;
        const steps = constraintLines(item.content);
        const isBusy = busy === item.id;
        return (
          <Panel
            key={item.id}
            eyebrow="Needs review"
            title={item.intent_description ?? 'A recalled procedure'}
            actions={
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge tone={rateTone(item.quality_score)} dot>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{rate}%</span> success
                </Badge>
                <Tag>used ×{item.injection_count}</Tag>
              </span>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
              {/* Success-rate bar — the decision signal, led visually. */}
              <div
                role="img"
                aria-label={`success rate ${rate} percent over ${runs} prior runs`}
                style={{ height: 6, borderRadius: 3, background: 'var(--surface)', overflow: 'hidden' }}
              >
                <div
                  style={{
                    width: `${rate}%`,
                    height: '100%',
                    background: rate >= 60 ? 'var(--ok, #5a8)' : rate >= 40 ? 'var(--info, #59c)' : 'var(--text-secondary)',
                  }}
                />
              </div>
              <p style={{ margin: 0, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', fontSize: 13 }}>
                {item.success_count} kept · {item.failure_count} flagged · {runs} runs total
              </p>

              {steps.length > 0 ? (
                <div>
                  <p style={{ margin: '0 0 4px', color: 'var(--text-secondary)', fontSize: 13 }}>Key steps it teaches:</p>
                  <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-primary)', lineHeight: 1.6 }}>
                    {steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-primary)', lineHeight: 1.6 }}>
                  {item.content ?? '(no detail recorded)'}
                </p>
              )}

              {/* Actions: one primary (Keep); Retire is destructive → separated + inline confirm. */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isBusy}
                  iconLeft={<Icon name="check" />}
                  aria-label={`Keep: ${item.intent_description ?? 'procedure'}`}
                  onClick={() => void act(item, 'success')}
                >
                  Keep
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isBusy}
                  iconLeft={<Icon name="zap" />}
                  aria-label={`Mark for rework: ${item.intent_description ?? 'procedure'}`}
                  onClick={() => void act(item, 'failure')}
                >
                  Needs work
                </Button>
                <span style={{ flex: 1 }} />
                {confirmRetire === item.id ? (
                  <>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Retire this?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={isBusy}
                      aria-label={`Confirm retire: ${item.intent_description ?? 'procedure'}`}
                      onClick={() => void act(item, 'retire')}
                    >
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => setConfirmRetire(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={isBusy}
                    iconLeft={<Icon name="x" />}
                    aria-label={`Retire: ${item.intent_description ?? 'procedure'}`}
                    onClick={() => setConfirmRetire(item.id)}
                  >
                    Retire
                  </Button>
                )}
              </div>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
