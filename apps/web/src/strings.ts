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
      payments: "Payments",
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
      body: "Webhooks, jobs and payment attempts appear here as they happen. None have been recorded. Carnet checks Airwallex every 60 seconds even without webhooks.",
    },
    intro:
      "Service levels and health, computed from the timestamps Carnet stores in its database. Figures cover the last 24 hours unless a card says otherwise.",
    generatedAt: "Computed at",
    utc: "UTC",
    slo: {
      title: "Service levels",
      webhookAck: "Webhook acknowledged, p95",
      webhookAckDefinition:
        "Time from a webhook request arriving to its event and job being committed. Target under 300 ms.",
      jobQueue: "Job wait, p95",
      jobQueueDefinition:
        "Time from a job being queued to the worker picking it up, for jobs that succeeded on the first try.",
      jobProcessing: "Job processing, p95",
      jobProcessingDefinition:
        "Time the worker spent on its last attempt, for jobs that succeeded.",
      meets: "Meets target",
      misses: "Misses target",
      noData: "No data yet",
      samples: "samples",
      median: "Median",
      target: "Target",
      window: "Last 24 hours",
      windowNow: "Right now",
      windowAllTime: "All time",
    },
    health: {
      title: "Worker and queue",
      queueDepth: "Jobs waiting or running",
      queueDepthDefinition: "Jobs pending, waiting to retry, or running now.",
      deadJobs: "Jobs that gave up",
      deadJobsDefinition:
        "Jobs that failed every retry and stopped (DEAD). Target: none in the last 24 hours.",
      deadJobsWindow: "In the last 24 hours",
      deadJobsAllTime: "All time",
      heartbeatWindow: "Most recent report",
      heartbeat: "Worker heartbeat",
      heartbeatDefinition: "When the worker last reported in. It reports every 30 seconds.",
      heartbeatStale: "The worker has not reported in the last 2 minutes.",
      heartbeatNone: "No worker has reported yet.",
      lastReport: "Last report",
    },
    reconciler: {
      lastRun: "Last reconcile run",
      definition:
        "When Carnet last finished checking Airwallex for missed updates. It runs every 60 seconds.",
      stale:
        "The reconciler has not completed in the last 3 minutes. Missed webhooks will not be recovered until it runs.",
      never: "The reconciler has not completed a run yet.",
      window: "Most recent run",
    },
    money: {
      title: "Payments needing attention",
      incidents: "Paid, then failed",
      incidentsDefinition:
        "Transfers Airwallex reported as paid that later failed, from the audit log, in the last 24 hours.",
      unknown: "Attempts being confirmed",
      unknownDefinition:
        "Requests sent to Airwallex whose result is not known yet. Carnet looks them up; it never resends them.",
    },
    later: {
      title: "Coming with later work",
      agentRuns: "Agent runs and model spend",
      agentRunsBody: "Model runs, tokens, cost and latency appear here once drafting is built.",
      auditChain: "Audit chain check",
      auditChainBody:
        "A check that the audit log has not been altered appears here once the hash chain is built.",
    },
    error: {
      panel:
        "Carnet could not compute these figures. No payment was affected. Try again in a minute.",
    },
    loading: {
      status: "Loading system health",
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
  payee: {
    // The public status page (M3-06). Plain words only: no amount, name, reference or reason.
    public: {
      title: "Payment status",
      heading: "Payment status",
      statusLabel: "Status",
      updatedLabel: "Last updated",
      processing: "Processing",
      sent: "Sent",
      paid: "Paid",
      failed: "Failed",
      delayed: "Delayed for verification",
      footnote: "This page shows the latest status reported for one payment. It is read-only.",
      unavailableTitle: "This link is not available",
      unavailableBody:
        "Check the link you were given, or ask the person who sent it to share a new one.",
      limitedTitle: "Too many requests",
      limitedBody: "Wait a minute, then open the link again.",
      errorTitle: "Status is unavailable right now",
      errorBody: "Try again in a few minutes.",
    },
    // The owner panel on the payment page.
    owner: {
      title: "Payee status link",
      intro:
        "Give your payee a read-only link that shows where this payment stands. Carnet does not send it: copy it and share it yourself.",
      create: "Create status link",
      createPending: "Creating link",
      levelLegend: "What the payee will see",
      levelGeneric: "Standard status",
      levelGenericHint:
        "Processing, Sent, Paid or Failed. A payment held for information reads Processing.",
      levelDelayed: "Say when it is delayed for verification",
      levelDelayedHint:
        "While the payment is held, the payee sees Delayed for verification instead of Processing.",
      expiryLabel: "Link expires after",
      expiryHint: "Between 1 hour and 30 days.",
      expiryHours: "hours",
      newLinkTitle: "Your new link",
      newLinkHint:
        "Copy it now. For security Carnet shows this address once and cannot show it again.",
      linkLabel: "Link address",
      copy: "Copy link",
      copied: "Link copied",
      listTitle: "Links for this payment",
      empty: "No status links yet. Create one to share the status of this payment.",
      expires: "Expires",
      created: "Created",
      lastViewed: "Last opened",
      neverViewed: "Not opened yet",
      stateActive: "Active",
      stateExpired: "Expired",
      stateRevoked: "Revoked",
      revoke: "Revoke link",
      revokePending: "Revoking link",
      revokeLabel: "Revoke link created {created}",
      loading: "Loading links",
      errorLoad: "Carnet could not load the links. Nothing was changed. Try again.",
      errorCreate: "Carnet could not create the link. Nothing was shared. Try again.",
      errorRevoke: "Carnet could not revoke the link. It may still work. Try again.",
      errorForbidden: "Your role cannot create or revoke links. Ask an owner or approver.",
      replayed:
        "This link was already created and its address cannot be shown again. Revoke it and create a new one.",
      readOnly: "This login is read-only, so it cannot create or revoke links.",
    },
    page: {
      title: "Payment",
      back: "Back to the queue",
      reference: "Reference",
      amount: "Amount",
      status: "Status at Airwallex",
      noTransfer: "No transfer yet",
      loading: "Loading payment",
      view: {
        AWAITING_APPROVAL: "Awaiting approval",
        NOT_SENT: "Not sent",
        SCHEDULED: "Scheduled",
        OVERDUE: "Overdue",
        PROCESSING: "Processing",
        SENT: "Sent",
        PAID: "Paid",
        FAILED: "Failed",
      },
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
      stale: {
        title: "This may be out of date",
        body: "Carnet could not refresh this page for {seconds} seconds. What you see is the last update it received. It keeps trying.",
        checkNow: "Check now",
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
    forbidden: {
      title: "Your role cannot open this page",
      body: "Ask the owner of this business if you need access. Nothing was changed.",
    },
  },
  money: {
    unavailable: "Amount unavailable",
  },
  status: {
    label: "Transfer status",
    transfer: {
      none: { label: "Not sent", hint: "No transfer has been created in Airwallex yet." },
      inApproval: {
        label: "In approval",
        hint: "Waiting for approval in your Airwallex account.",
      },
      approvalRecalled: {
        label: "Approval recalled",
        hint: "The approval request was withdrawn in Airwallex. Nothing was sent.",
      },
      approvalRejected: {
        label: "Approval rejected",
        hint: "An approver in Airwallex rejected this transfer. Nothing was sent.",
      },
      approvalBlocked: {
        label: "Approval blocked",
        hint: "Airwallex blocked the approval. Nothing was sent.",
      },
      scheduled: {
        label: "Scheduled",
        hint: "Airwallex has the transfer and will process it on the value date.",
      },
      overdue: {
        label: "Overdue",
        hint: "Past its scheduled date and not yet processed. Airwallex reports it as overdue.",
      },
      processing: { label: "Processing", hint: "Airwallex is processing the transfer." },
      sent: {
        label: "Sent, not yet paid",
        hint: "Airwallex has sent the funds. Sent is not final; it can still fail.",
      },
      paid: {
        label: "Paid",
        hint: "Airwallex reports the funds as paid. A paid transfer can still be returned.",
      },
      failed: { label: "Failed", hint: "Airwallex reports: {failureReason}" },
      cancelledFailed: {
        label: "Not sent (failed)",
        hint: "Airwallex ended this transfer: {failureReason}. This does not mean anyone cancelled it.",
      },
      cancelled: {
        label: "Cancelled",
        hint: "Airwallex reports the transfer as cancelled. Nothing was sent.",
      },
      unknown: {
        label: "Unknown status",
        hint: "Airwallex returned a status Carnet does not know: {raw}.",
      },
      failureUnknown: "no reason given",
      failureReasons: {
        INCORRECT_ROUTING: "the bank routing details were not accepted",
        INCORRECT_ACCOUNT_NUMBER: "the account number was not accepted",
        ACCOUNT_CLOSED: "the beneficiary account is closed",
        BENEFICIARY_BANK_REJECTED: "the beneficiary bank rejected the payment",
      },
    },
    attempt: {
      sending: {
        label: "Sending to Airwallex",
        hint: "Carnet saved the payment and is sending it to Airwallex.",
      },
      unknown: {
        label: "Confirming with Airwallex",
        hint: "Airwallex did not confirm in time. Carnet is looking the request up before doing anything else; it will not send it twice.",
      },
      rejected: {
        label: "Refused by Airwallex",
        hint: "Airwallex refused this transfer. Nothing was sent.",
      },
    },
  },
  payments: {
    title: "Sandbox payments",
    intro:
      "Each status is what Airwallex last reported to Carnet, through a webhook or Carnet's check every 60 seconds. This page looks for changes every 3 seconds.",
    loading: "Loading payments",
    loadingOne: "Loading payment",
    empty: {
      title: "No payments yet",
      bodyOwner:
        "Create a sandbox payment to watch it move through Airwallex. Nothing has been sent.",
      bodyViewer: "The owner has not created a payment yet. Nothing has been sent.",
    },
    list: {
      title: "Payments",
      caption: "Sandbox payments, newest first",
      reference: "Reference",
      amount: "Amount",
      status: "Status",
      created: "Created",
    },
    readOnly: "You can look at payments. Only the owner can create one.",
    create: {
      title: "Create a sandbox payment",
      body: "Carnet checks the sandbox wallet, then sends a real transfer in the Airwallex sandbox to the demo supplier. No real money moves.",
      amount: "Amount (USD)",
      amountHint: "Up to 2 decimals, for example 25.00.",
      reference: "Reference",
      referenceHint: "Shown to the supplier, for example an invoice number.",
      submit: "Create payment",
      submitPending: "Creating payment",
      errorAmount: "Enter an amount greater than 0 with at most 2 decimals.",
      errorReference: "Enter a reference.",
      errorGeneric: "The payment could not be created. Nothing was sent. Try again.",
      errorOffline: "Carnet did not answer. Nothing was sent. Check your connection and try again.",
    },
    live: {
      checked: "Live · checked {seconds} s ago",
      retrying: "Retrying · last checked {seconds} s ago",
      paused: "Paused while this tab is hidden",
    },
    announce: {
      status: "{reference}, {amount}: Airwallex reports {status}.",
      attempt: "{reference}, {amount}: {state}.",
      several: "{count} payments changed status.",
    },
    detail: {
      back: "All payments",
      progress: "Progress",
      stepSaved: "Saved in Carnet",
      stepSent: "Sent to Airwallex",
      stepConfirmed: "Airwallex created the transfer",
      stepWaiting: "Waiting",
      stepRefused: "Airwallex refused the transfer",
      failureCode: "Airwallex failure code",
      failedNext:
        "Nothing more will happen to this transfer. Check the supplier's bank details, then create a new payment.",
      transfer: "Transfer",
      transferId: "Airwallex transfer id",
      requestId: "Request id",
      method: "Method",
      lastUpdate: "Last update from Airwallex",
      notYet: "Not yet",
      webhooks: "Updates received from Airwallex",
      webhooksEmpty:
        "No webhook has arrived for this transfer yet. Carnet also checks Airwallex every 60 seconds.",
      webhooksCaption: "Webhooks that named this transfer, oldest first",
      event: "Event",
      received: "Received",
      signature: "Signature",
      signatureOk: "Verified",
      signatureBad: "Not verified",
      processed: "Applied",
      pending: "Pending",
    },
    simulate: {
      title: "Sandbox controls",
      body: "Ask the Airwallex sandbox to move this transfer on. The change comes back as a normal Airwallex update; nothing on this page changes until it does.",
      sent: "Simulate sent",
      paid: "Simulate paid",
      pending: "Asking the sandbox",
      queued: "Requested. The new status appears when Airwallex reports it.",
      error: "The request could not be queued. Nothing changed. Try again.",
      needsTransfer: "Available once Airwallex has created the transfer.",
      noneAvailable: "No sandbox step is available for this payment in its current state.",
    },
  },
} as const;

/** Fills `{name}` placeholders in a string from `strings.ts`. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export const strings = { en } as const;

export type Locale = keyof typeof strings;
export type Strings = (typeof strings)[Locale];

/** The active locale's strings. Only `en` exists (a second locale is out of scope, M1-07). */
export const t: Strings = strings.en;

/** The BCP 47 locale passed to the `Intl` helpers in `lib/intl.ts`. */
export const locale = "en-US";
