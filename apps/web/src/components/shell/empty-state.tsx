import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Empty-state pattern (docs/design/states.md): an icon, a title that says what is absent, a body that
 * says why and what happens next, and an optional action. Honest copy: an empty list never implies
 * that something was sent or done.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  headingLevel = 2,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
  /** 1 when the empty state is the whole page (login, not found), 2 under a page title. */
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      aria-labelledby="empty-state-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-md border border-border bg-card p-6 md:p-8"
    >
      <span className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <Heading
        id="empty-state-title"
        className={
          headingLevel === 1
            ? "text-xl leading-tight font-semibold md:text-2xl"
            : "text-lg leading-tight font-semibold"
        }
      >
        {title}
      </Heading>
      <p className="max-w-[65ch] text-pretty text-muted-foreground">{body}</p>
      {action}
    </section>
  );
}

/** A screen title: 22px below 768px, 28px from 768px (docs/design/tokens.md type scale). */
export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-6 text-xl leading-tight font-semibold md:text-2xl">{children}</h1>;
}
