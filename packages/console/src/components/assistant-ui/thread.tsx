'use client';

/**
 * Thread — the embedded MemexTerminal conversation surface, built from
 * assistant-ui primitives (Thread/Message/Composer/ActionBar) and skinned
 * with the observatory design tokens. Icons are Heroicons.
 *
 * Visual classes live in .mx-chat-* (src/styles/ds-components.css).
 */

import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  CheckIcon,
  ClipboardIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { Logo } from '@/components/Logo';
import { MarkdownText } from './markdown-text';

const SUGGESTIONS = [
  'What can you remember about this system?',
  'Summarize the most recent trails',
  'What lessons have you crystallized?',
];

export function Thread() {
  return (
    <ThreadPrimitive.Root className="mx-chat">
      <ThreadPrimitive.Viewport className="mx-chat__viewport">
        <ThreadPrimitive.Empty>
          <Welcome />
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage }}
        />

        <ThreadPrimitive.ViewportFooter className="mx-chat__footer">
          <ThreadPrimitive.ScrollToBottom asChild>
            <button className="mx-chat__scrolldown" aria-label="Scroll to bottom">
              <ArrowDownIcon style={{ width: 14, height: 14 }} />
            </button>
          </ThreadPrimitive.ScrollToBottom>
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function Welcome() {
  return (
    <div className="mx-chat__welcome">
      <Logo size={44} />
      <h2 className="mx-chat__welcome-title">Speak to the Memex</h2>
      <p className="mx-chat__welcome-sub">
        every turn is written to the trail mesh — the conversation is the graph
      </p>
      <div className="mx-chat__suggestions">
        {SUGGESTIONS.map((s) => (
          <ThreadPrimitive.Suggestion key={s} prompt={s} method="replace" autoSend asChild>
            <button className="mx-chat__suggestion">{s}</button>
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-chat__msg mx-chat__msg--user">
      <div className="mx-chat__bubble-user">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mx-chat__msg mx-chat__msg--assistant">
      <div className="mx-chat__avatar" aria-hidden>
        <Logo size={18} />
      </div>
      <div className="mx-chat__assistant-body">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mx-chat__error">
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="mx-chat__actions"
    >
      <ActionBarPrimitive.Copy asChild>
        <button className="mx-iconbtn" aria-label="Copy reply">
          <MessagePrimitive.If copied>
            <CheckIcon style={{ width: 15, height: 15, color: 'var(--status-ok)' }} />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <ClipboardIcon style={{ width: 15, height: 15 }} />
          </MessagePrimitive.If>
        </button>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <button className="mx-iconbtn" aria-label="Regenerate">
          <ArrowPathIcon style={{ width: 15, height: 15 }} />
        </button>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="mx-chat__composer">
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        placeholder="speak to the memex…"
        className="mx-chat__input"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <button className="mx-chat__send" aria-label="Send">
            <ArrowUpIcon style={{ width: 16, height: 16 }} />
          </button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <button className="mx-chat__send mx-chat__send--stop" aria-label="Stop">
            <StopIcon style={{ width: 16, height: 16 }} />
          </button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}
