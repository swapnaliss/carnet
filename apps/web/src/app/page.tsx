import { Activity, CalendarRange, ChevronRight, ListChecks, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

const sections: ReadonlyArray<{ href: string; icon: LucideIcon; title: string; body: string }> = [
  { href: "/queue", icon: ListChecks, ...t.home.sections.queue },
  { href: "/plan", icon: CalendarRange, ...t.home.sections.plan },
  { href: "/ops", icon: Activity, ...t.home.sections.ops },
];

export default function Home() {
  return (
    <>
      <PageTitle>{t.home.title}</PageTitle>
      <p className="mb-8 max-w-[68ch] text-muted-foreground">{t.home.body}</p>
      <ul className="grid gap-3 md:grid-cols-3">
        {sections.map(({ href, icon: Icon, title, body }) => (
          <li key={href}>
            <Link
              href={href}
              className="group flex h-full items-start gap-3 rounded-md border border-border bg-card p-4 transition-colors duration-(--duration-fast) hover:bg-accent md:p-5"
            >
              <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-1 font-semibold text-foreground">
                  {title}
                  <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                </span>
                <span className="text-sm text-muted-foreground">{body}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
