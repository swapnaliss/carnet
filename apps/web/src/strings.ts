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
      sandbox: "Sandbox · no real money",
      sandboxHint: "Carnet uses the Airwallex sandbox only.",
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
      body: "When you add the payments for a goal, Carnet checks each one's evidence here before anything moves. Nothing has been sent.",
    },
  },
  plan: {
    title: "Plan",
    empty: {
      title: "No plan yet",
      body: "The plan shows what must be paid by when, and how it changes while a payment is held. It appears once there are payments with due dates. Carnet has not scheduled anything.",
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
      body: "Use the email and password your business gave you. There is no public sign-up.",
      back: "Back to Carnet home",
      email: "Email",
      password: "Password",
      submit: "Sign in",
      submitPending: "Signing in",
      errorInvalid: "Email or password is incorrect.",
      errorRateLimited: "Too many failed attempts. Wait 15 minutes, then try again.",
      errorGeneric: "Sign-in is unavailable right now. Try again in a moment.",
    },
    session: {
      title: "You are signed in",
      roleLabel: "Role",
      readOnly: "This login is read-only. It can look at everything and change nothing.",
      signOut: "Sign out",
      signOutPending: "Signing out",
      signOutError: "Sign-out failed. Try again.",
    },
    role: {
      owner: "Owner",
      approver: "Approver",
      viewer: "Viewer (read-only)",
    },
  },
  common: {
    state: {
      loading: "Loading",
      retry: "Try again",
      error: {
        title: "Carnet could not load this page",
        body: "No money or answers were sent from this page. Try again, or go to the queue.",
        correlationId: "Reference for support",
      },
    },
    action: {
      home: "Go to Carnet home",
      queue: "Go to the queue",
      copy: "Copy",
      copied: "Copied",
    },
    notFound: {
      title: "Page not found",
      body: "This page does not exist, or it belongs to another business.",
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
