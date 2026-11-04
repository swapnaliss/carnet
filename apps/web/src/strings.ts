// Every user-facing string in the web app (ADR 0017). Components read `t.<area>.<region>.<element>`
// and never contain a literal; test/strings.test.ts enforces that for the shell.
// Key convention (docs/design/README.md): dotted camelCase paths `<area>.<screen-or-component>.<element>`,
// variants as a camelCase suffix (`ctaPending`). HOT FILE: add keys, never reorder or rename.
// Copy rules: sentence case, no exclamation marks, never overclaim (docs/design/README.md).

const en = {
  app: {
    name: "Carnet",
    tagline: "A payment that carries its paperwork.",
    description:
      "Carnet checks the evidence for a cross-border payment, drafts answers to Airwallex information requests from your documents, and re-plans payroll and suppliers while a payment is held.",
  },
  shell: {
    skipLink: "Skip to main content",
    nav: {
      label: "Main",
      queue: "Queue",
      plan: "Plan",
      ops: "Ops",
    },
    header: {
      home: "Carnet home",
      sandbox: "Sandbox",
      sandboxHint: "Connected to the Airwallex sandbox. No real money moves.",
    },
  },
  home: {
    title: "Get this week's payments out, with the paperwork attached",
    body: "Carnet checks each payment's documents before it moves. If Airwallex holds a payment for information, Carnet drafts the answers from your documents for one approval and re-plans the rest of the week around the hold.",
    sections: {
      queue: {
        title: "Queue",
        body: "Your payments, their evidence, and what Airwallex reports for each transfer.",
      },
      plan: {
        title: "Plan",
        body: "What must be paid by when, and how the plan changes while a payment is held.",
      },
      ops: {
        title: "Ops",
        body: "Health of the connection to Airwallex: webhooks, jobs, attempts and the audit trail.",
      },
    },
  },
  queue: {
    title: "Payment queue",
    empty: {
      title: "No payments yet",
      body: "Payments appear here once a business goal and its payments are added. Nothing has been sent.",
    },
  },
  plan: {
    title: "Plan",
    empty: {
      title: "No plan yet",
      body: "A plan appears once there are payments with due dates. Carnet has not scheduled anything.",
    },
  },
  ops: {
    title: "Ops",
    empty: {
      title: "No activity yet",
      body: "Webhooks, jobs and payment attempts appear here as they happen. None have been recorded.",
    },
  },
  auth: {
    login: {
      title: "Sign in to Carnet",
      body: "Sign-in is not available in this build yet. It arrives with the accounts step; until then there is nothing to sign in to.",
      back: "Back to Carnet home",
    },
  },
  common: {
    state: {
      loading: "Loading",
      retry: "Try again",
      error: {
        title: "This page could not be shown",
        body: "Something went wrong while loading it. No payment or answer was sent. Try again, or go back to the home page.",
      },
    },
    action: {
      home: "Go to Carnet home",
    },
    notFound: {
      title: "Page not found",
      body: "There is no page at this address. It may have moved, or the link may be mistyped.",
    },
  },
} as const;

export const strings = { en } as const;

export type Locale = keyof typeof strings;
export type Strings = (typeof strings)[Locale];

/** The active locale's strings. Only `en` exists (a second locale is out of scope, M1-07). */
export const t: Strings = strings.en;

/** The BCP 47 locale passed to the `Intl` helpers in `lib/intl.ts`. */
export const locale = "en-US";
