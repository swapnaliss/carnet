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
      rfis: "Requests",
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
    title: "Payments",
    empty: {
      title: "No payments yet",
      body: "When you add the payments for a goal, Carnet checks each one's evidence here before anything moves. Nothing has been sent.",
      cta: "Add a payment",
    },
    emptyFiltered: {
      title: "No payments match these filters",
      body: "Change or clear the filters to see the other payments.",
    },
    intro:
      "Each payment shows whether its documents would hold up in a review, and what Airwallex last reported for its transfer. Nothing moves until you send it.",
    loading: { status: "Loading payments" },
    error: {
      load: "Carnet could not load your payments. Nothing was sent or changed.",
    },
    summary: {
      counts:
        "{total} payments \u00b7 {sent} reported by Airwallex \u00b7 {waiting} waiting for Airwallex \u00b7 {notSent} not sent \u00b7 {held} of them held \u00b7 evidence: {strong} strong, {weak} weak, {missing} missing",
    },
    filter: {
      label: "Filter payments",
      evidenceGroup: "Evidence strength",
      statusGroup: "Show",
      currencyGroup: "Currency",
      needsEvidence: "Needs evidence",
      held: "Held",
      all: "All",
      strong: "Strong",
      weak: "Weak",
      missing: "Missing",
      notSent: "Not sent",
      inFlight: "In flight",
      paid: "Paid",
      clear: "Clear filters",
      resultCount: "{count} payments shown",
      resultCountOne: "1 payment shown",
    },
    table: {
      caption:
        "Payments, newest first, with the strength of their evidence and their transfer status",
      counterparty: "Payee",
      reference: "Reference",
      amount: "Amount",
      evidence: "Evidence",
      status: "Transfer",
      nextStep: "Next step",
      created: "Created",
    },
    next: {
      review: "Review evidence",
      send: "Send",
      acknowledge: "Acknowledge and send",
      view: "View payment",
      waiting: "Waiting for Airwallex",
    },
    unnamedPayee: "No payee set",
    stale: {
      title: "Transfer statuses may be out of date",
      body: "Transfer statuses were last checked with Airwallex {minutes} min ago. Carnet is retrying. What you see is the last status it stored.",
      never:
        "Carnet has not checked transfer statuses with Airwallex yet. What you see is the last status it stored.",
    },
    goal: {
      label: "Goal",
      emptyTitle: "No goal set yet",
      emptyBody:
        "When you add what must be paid and by when, the goal and its deadline appear here. Until then Carnet shows each payment on its own.",
      planLink: "See the plan",
    },
    held: {
      title: "Held for information",
      body: "{payee} \u00b7 {amount} is held for information by Airwallex.",
      deadline: "Answer by {date}.",
      noDeadline: "Airwallex has not given a deadline.",
      cta: "Review and answer",
      badge: "Held for information",
    },
    updated: "Updated {time} \u00b7 Live",
    updatedStale: "Updated {time}",
    due: "Due",
    dueNotSet: "Not set",
    criticalityNotSet: "Criticality not set",
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
    },
    auditChain: {
      title: "Audit log integrity",
      card: "Audit chain",
      ok: "Chain intact",
      broken: "Chain broken",
      notChecked: "Not checked yet",
      okDetail: "Every row links to the one before it and its hash matches.",
      brokenDetail: "First bad row",
      rowsVerified: "rows verified",
      head: "Head",
      lastVerified: "Last verified",
      definition:
        "Each audit row stores the hash of the row before it. The worker recomputes the whole chain every few minutes and stores the result here.",
      window: "Latest stored check",
      pending: "The worker has not stored a check yet. It verifies the chain every 5 minutes.",
      reasons: {
        HASH_MISMATCH: "a row was changed",
        LINK_MISMATCH: "a row is missing or out of order",
        GAP: "the log has fewer rows than were written",
        GENESIS_MISMATCH: "the first row was removed",
        HEAD_MISMATCH: "the newest row was removed",
      },
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
  },
  rfis: {
    title: "Requests from Airwallex",
    intro:
      "Airwallex asks for information about a transfer before it decides. Carnet drafts the answers from your documents; you approve once.",
    loading: "Loading requests",
    empty: {
      title: "No requests from Airwallex",
      body: "When Airwallex asks for information about a transfer, it appears here with a draft answer. Nothing is waiting for you.",
    },
    error: {
      title: "Carnet could not load the requests",
      body: "Nothing was sent. Try again.",
    },
    linked: "Held payments",
    orphan: "Not linked to a payment",
    orphanHint:
      "Carnet could not tell which payment these relate to. Link one, or answer in Airwallex.",
    columns: {
      request: "Request",
      payment: "Payment",
      state: "State",
      deadline: "Answer by",
    },
    unlinked: "No payment linked",
    open: "Open request",
    linkLabel: "Link to payment",
    linkNone: "Choose a payment",
    linkCta: "Link payment",
    linkPending: "Linking",
    linkError: "Carnet could not link the request. Nothing was changed.",
    reasons: {
      NO_SOURCES: "Airwallex named no transfer.",
      NON_TRANSFER_SOURCE: "Airwallex named something other than a transfer.",
      UNKNOWN_TRANSFER: "Airwallex named a transfer Carnet has no record of.",
      MULTIPLE_PAYMENTS: "Airwallex named transfers that belong to several payments.",
      OWNER_UNLINKED: "You removed the link.",
    },
  },
  hold: {
    loading: { status: "Loading the request for information" },
    header: {
      back: "Requests",
      heldExplainer:
        "Airwallex asked for information about this transfer. Its status stays as Airwallex reports it until Airwallex decides.",
      unlinked: "This request is not linked to a payment.",
      deadline: "Answer by {when}",
      deadlineRelative: "{relative} left",
      deadlineNone: "No deadline reported",
      rfiId: "Request {id}",
      round: "Round {round}",
      rfiDetails: "Request details",
      airwallexStatus: "Airwallex status",
      carnetState: "Carnet state",
      type: "Type",
      transfer: "Transfer status",
    },
    status: {
      held: {
        label: "Held for information",
        hint: "Airwallex is waiting for answers before it decides.",
      },
      unlinkedTransfer: "No transfer status yet",
    },
    summary: {
      counts: "{total} questions · {ready} ready · {needs} need you",
      countsDrafting: "{total} questions · Carnet is drafting",
    },
    questions: { heading: "Questions from Airwallex" },
    question: {
      position: "Question {position} of {total}: {title}",
      answerTypeAttachment: "Attachment",
      answerTypeText: "Text",
      statusReady: "Ready",
      statusSent: "Sent",
      statusNeedsOwner: "Needs you",
      statusEdited: "Edited by you",
      statusYours: "Your statement",
      statusDrafting: "Drafting",
      drafting: "Carnet is drafting this answer from your documents.",
      reopened: "Reopened by Airwallex",
      noDraft: "No draft yet for this question.",
      select: "Question {position}: {title}",
      list: "Questions",
    },
    needsOwner: {
      heading: "Carnet could not ground this answer",
      blocksRfi:
        "Airwallex needs every question answered, so this question blocks the whole request.",
      doNext: "What you can do",
      write: "Write the answer yourself.",
      attach: "Attach a document that answers it.",
      confirm: "Confirm a fact in a document, then Carnet can draft it.",
      noDocument: "No document on file answers this question. Carnet will not invent one.",
      verifierRejected: "The drafted answer did not pass Carnet's check against your documents.",
      imageOnly: "The only document is an image whose facts you have not confirmed.",
      contradiction: "Your documents disagree with each other on a fact this answer needs.",
      modelUnavailable: "Carnet could not draft this answer right now. You can write it yourself.",
      unsupported: "Carnet does not answer this kind of question. You answer it.",
      staleReuse: "An earlier approved answer no longer matches the documents.",
      reason: "Reason",
    },
    claim: {
      label: "Claim {n}",
      list: "Claims in this answer",
      unverified: "Not found in your documents",
      yourStatement: "Your statement. Carnet could not check it against a document.",
      citedBy: "Cited by claims {claims}",
      noChip: "No source",
    },
    citation: {
      name: "Source: {document} page {page}, {state}",
      prefix: "Source:",
      verified: "Quote verified",
      ownerConfirmed: "Confirmed by you",
      notFound: "Source did not load",
    },
    source: {
      heading: "Sources",
      page: "page {page}",
      document: "Document {name}",
      openDocument: "Open document",
      showFullQuote: "Show full quote",
      hideFullQuote: "Hide full quote",
      noTextLayer: "This document has no text layer.",
      none: "No source for this question.",
      none2: "Carnet will not invent one.",
      sha: "sha256 {prefix}",
      failed: "Source did not load. Reload before approving.",
      cited: "Cited by claim {n}",
      kind: "Document kind: {kind}",
    },
    attachments: {
      heading: "Files that will be uploaded",
      file: "{name} · {kind} · {size} · sha256 {prefix}",
      none: "No file chosen.",
    },
    edit: {
      cta: "Edit answer",
      label: "Answer text",
      save: "Save edit",
      saving: "Saving…",
      cancel: "Cancel edit",
      discard: "Discard edit",
      sourcesYouCanCite: "Sources you can cite",
      cancelsApproval: "Editing will cancel your approval.",
      unsaved: "Not saved",
      rejectedTitle: "This edit did not pass the check",
      rejectedBody: "{explanation} The question stays blocked until the text is corrected.",
      savedVerified: "Saved. Every statement matches your documents.",
      error: "Carnet could not save the edit. Nothing changed. Try again.",
      hint: "Ctrl or Cmd plus Enter saves. It never approves.",
    },
    answer: {
      write: "Write an answer",
      writeLabel: "Your statement",
      writeHint:
        "This is your own statement. Carnet cannot check it against a document, and the approval says so.",
      attach: "Attach a document",
      attachChoose: "Choose a document already in Carnet",
      attachNone: "No document of Carnet's can be attached yet.",
      attachNotSendable: "Only PDF or JPEG files can be sent to Airwallex.",
      attachSave: "Use these documents",
      attachRemove: "Remove {name}",
      attachListLabel: "Documents in Carnet",
      upload: "Upload a document",
      uploadHint: "To add a new document, upload it on the documents page first.",
    },
    approval: {
      cta: "Approve and submit",
      ctaCount: "Approve and submit {count} answers",
      ctaCountOne: "Approve and submit 1 answer",
      ctaPending: "Submitting to Airwallex…",
      heading: "Approval",
      blocked: "{count} question needs your answer",
      blockedMany: "{count} questions need your answer",
      blockedGo: "Go to question {position}",
      readySummary: "Every question has an answer. One approval covers exactly what is shown.",
      draftingWait: "Carnet is drafting. Approval opens when every question has an answer.",
      hash: "Content hash {hash}",
      approvedWaiting: "Approved by you. Waiting for the answer to be sent to Airwallex.",
      submitted: "Answer submitted to Airwallex. The transfer keeps its own status.",
      invalidated: "The answers changed after you approved. Approve again.",
      expired: "Your approval expired before it was used. Approve again.",
      killSwitch: "Execution is switched off, so nothing can be approved or sent right now.",
      staleDisabled: "Waiting for fresh data from Airwallex",
      viewer: "This login is read-only, so it cannot approve.",
      unlinked: "Link this request to a payment first. Approval opens once it is linked.",
      tooClose: "This request expires too soon for an approval to last. Answer it in Airwallex.",
      notReady: "This request is {state}, so it cannot be approved.",
      editingLocked: "Editing is locked while an approval is waiting to be used.",
      withdraw: "Withdraw approval",
      withdrawing: "Withdrawing…",
      unknownWait:
        "Airwallex did not confirm in time. Carnet is looking the request up; it will not send it twice.",
    },
    steps: {
      approved: "Approved by you",
      sent: "Sent to Airwallex",
      confirming: "Waiting for Airwallex to confirm",
      done: "Airwallex confirmed",
    },
    dialog: {
      title: "Approve and submit",
      body: "Airwallex will receive exactly the answers below.",
      boundNotice:
        "This approval covers exactly this content. If anything changes, you will need to approve again. Airwallex reviews the answer and decides the transfer's outcome.",
      rfi: "Request {id}, round {round}",
      question: "Question {position}: {title}",
      yourStatements: "Statements Carnet could not check against a document",
      noAnswer: "No answer",
      confirm: "Approve and submit",
      confirmCount: "Approve and submit {count} answers",
      cancel: "Cancel",
      pendingNoEsc: "Submitting. This window closes when the server answers.",
      hashMismatch:
        "The answers changed since you opened this. Review the changes and approve again.",
      error: "Carnet could not record the approval. Nothing was sent. {message}",
      expandHash: "Show what this approval binds",
      draft: "Draft {id} · prompt {prompt}",
      attachments: "Attachments",
    },
    outcome: {
      answered: "Answer submitted to Airwallex at {time}.",
      transferUnchanged:
        "The transfer is still shown as Airwallex reports it; Airwallex decides the outcome.",
      readOnly: "Answers sent to Airwallex",
      closed: "Airwallex has closed this request.",
    },
    expired: {
      title: "This request expired. Ask Airwallex.",
      body: "Airwallex closed this request on {date} because the deadline passed. Carnet cannot answer it now.",
    },
    empty: {
      title: "No open request for this payment",
      body: "This payment has no open request for information.",
      cta: "Back to the requests",
    },
    error: {
      title: "Carnet could not load this request",
      load: "Carnet could not load this request from its database. Nothing was sent.",
      retry: "Try again",
      submitRejected:
        "Airwallex did not accept the answer. Your approval was not used for anything else; review and approve again.",
      submitDetails: "Airwallex said: {message}",
      injection:
        "A document cited here contained text that looked like an instruction. Carnet treated it as data and did not follow it.",
    },
    killSwitch: {
      title: "Execution is switched off",
      body: "Carnet will not approve or send answers right now. You can still read and edit drafts.",
    },
    drafting: {
      title: "Carnet is drafting answers",
      body: "Request received from Airwallex. Drafts appear here as soon as they are stored.",
    },
    live: {
      stateChanged: "Request state is now {state}.",
      draftReady: "Drafts are ready. {ready} of {total} questions ready.",
      needsYou: "{count} question needs your answer.",
      approved: "Approval recorded.",
      answered: "Answer submitted to Airwallex.",
    },
    states: {
      ACTION_REQUIRED: "Received",
      DRAFTING: "Drafting",
      DRAFT_READY: "Draft ready",
      NEEDS_OWNER: "Needs you",
      APPROVED: "Approved",
      ANSWER_SUBMITTING: "Submitting",
      ANSWERED: "Answered",
      CLOSED: "Closed",
      REOPENED: "Reopened",
      EXPIRED: "Expired",
    },
    keyboard: {
      label: "Keyboard",
      body: "Alt plus the down or up arrow moves between questions. Enter on a source opens the full quote. Ctrl or Cmd plus Enter saves an edit; it never approves.",
    },
    earlierRounds: { label: "Earlier rounds" },
    copy: { label: "Copy {what}", copied: "Copied" },
    staleDraft: "A newer draft exists. Reload to see it before approving.",
    skip: "Skip to the approval",
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
      body: "Save a payment to the demo supplier, add its documents, and send it once you have seen the evidence check. The transfer goes to the Airwallex sandbox; no real money moves.",
      amount: "Amount (USD)",
      amountHint: "Up to 2 decimals, for example 25.00.",
      reference: "Reference",
      referenceHint: "Shown to the supplier, for example an invoice number.",
      submit: "Create payment",
      submitPending: "Creating payment",
      draftHint:
        "Nothing is sent yet. You add the invoice and contract next, see how strong the evidence is, then send.",
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
  evidence: {
    title: "Evidence for {payee}",
    pageTitle: "Payment evidence",
    summary: {
      method: "Method",
      account: "Beneficiary account",
      accountNone: "Not recorded yet",
      due: "Due date",
      dueNone: "Not set",
    },
    citation: { label: "Show {document} in the documents", page: "p{page}" },
    notRun: "Carnet does not run this check yet, so it is not counted.",
    ruleExtra: {
      contractInForce: "Contract in force on the invoice date",
      fundsEvidence: "Funds evidence present",
    },
    approve: {
      cta: "Approve and send",
      title: "Approve and send this payment",
      body: "Check the details Carnet will send. Nothing is sent until you confirm below.",
      payTo: "Pay to",
      account: "Beneficiary account",
      amount: "Amount",
      reference: "Reference",
      source: "Paid from",
      sourceValue: "{currency} wallet in the Airwallex sandbox",
      fee: "Fee",
      feeValue: "Shown by Airwallex once the transfer exists",
      valueDate: "Value date",
      valueDateValue: "Set by Airwallex when it creates the transfer",
      cancel: "Cancel",
      stale: "Sending is paused until Carnet can refresh this page.",
      weakNotice:
        "Evidence is not strong. Your acknowledgement is recorded with the reasons shown.",
    },
    steps: {
      title: "Where this payment is",
      approved: "Approved by you",
      sent: "Sent to Airwallex",
      confirming: "Waiting for Airwallex to confirm",
      confirmed: "Airwallex created the transfer",
    },
    openLink: "Evidence for this payment",
    back: "All payments",
    backToQueue: "Back to the queue",
    loading: { status: "Loading evidence" },
    strength: {
      label: "Evidence",
      strong: "Strong evidence",
      weak: "Weak evidence",
      missing: "Evidence missing",
      checksRun: "{run} of {total} checks run",
      summaryStrong: "The checks Carnet runs on these documents passed.",
      summaryWeak: "Some documents do not support this payment, or Carnet could not verify them.",
      summaryMissing: "Carnet cannot check this payment until the missing documents are added.",
    },
    reasonsTitle: "Why",
    tabs: { label: "Evidence sections", checks: "Checks", documents: "Documents" },
    rule: {
      amount: "Amount matches the invoice",
      payee: "Payee matches the invoice supplier",
      contract: "A contract names the payee",
      verified: "Facts are verified",
      consistent: "Documents agree with each other",
      invoiceMatchesPo: "Invoice and purchase order agree",
      beneficiaryMatchesContract: "Beneficiary account matches the contract",
    },
    check: {
      caption: "Checks Carnet ran on this payment's documents",
      check: "Check",
      result: "Result",
      detail: "What Carnet found",
      passed: "Passed",
      failed: "Failed",
      notChecked: "Not checked",
      none: "No documents are linked yet, so no check could run.",
      contractNote: "A contract is required for a first payment above {threshold}.",
    },
    reason: {
      noInvoice: "No invoice is linked to this payment.",
      amountMatch: "The invoice total {amount} matches the payment ({document}).",
      amountMismatch:
        "The invoice total {invoice} does not match the payment amount {payment} ({document}, page {page}).",
      amountCurrencyMismatch:
        "The invoice is in a different currency: {invoice}, but the payment is {payment} ({document}, page {page}).",
      amountNoFact:
        "Carnet has no verified invoice total to compare with the payment of {payment}.",
      payeeMatch: "The invoice supplier matches the payee {payee} ({document}).",
      payeeMismatch:
        "The invoice names {invoice}, but the payee is {payee} ({document}, page {page}). A near match is not accepted.",
      payeeNoFact:
        "Carnet has no verified supplier name on an invoice to compare with the payee {payee}.",
      contractNamesPayee: "The contract names {payee} ({document}).",
      contractNamesOther:
        "The contract names \u201c{contract}\u201d, not {payee} ({document}, page {page}).",
      contractNoFact:
        "A contract is linked, but Carnet has no verified party names to compare with {payee}.",
      contractMissing:
        "This is the first payment to {payee} above the contract threshold, and no contract is linked.",
      verifiedAll: "Every fact Carnet used is quoted from a document or confirmed by you.",
      unverifiedFact: "{document}: the {fact} fact is not verified, so Carnet did not use it.",
      extractionFailed: "Carnet could not read {document}, so none of its facts were used.",
      extractionPending: "Carnet is still reading {document}.",
      totalsAgree: "The invoice and the purchase order agree on {total}.",
      totalsDiffer:
        "The invoice total {invoice} ({invoiceDocument}) differs from the purchase order total {purchaseOrder} ({purchaseOrderDocument}).",
      accountsAgree: "The invoice account {account} is the account the contract names.",
      accountsDiffer:
        "The invoice account {invoice} ({invoiceDocument}) is not the account the contract names ({contractDocument}).",
      allPassed:
        "Every check Carnet runs passed, and every fact is quoted from a document or confirmed by you. Contract in force and funds evidence are not checked yet.",
    },
    documents: {
      title: "Documents",
      list: "Documents linked to this payment",
      empty: {
        title: "No documents are linked to this payment",
        body: "Carnet cannot check it until you add the invoice and, if there is one, the contract.",
      },
      kind: {
        invoice: "Invoice",
        contract: "Contract",
        purchase_order: "Purchase order",
        statement: "Bank statement",
        other: "Other document",
      },
      meta: "{kind} · {size} · SHA-256 {hash}",
      textLayerNo: "Scanned image, no text layer",
      reading: "Reading document",
      readFailed: "Carnet could not read this document",
      readFailedWhy:
        "Carnet could not read this document, so none of its facts are used. Remove it and add a clearer copy.",
      noFacts: "No facts were extracted from this document.",
      open: "Open document",
      remove: "Remove from this payment",
      removeLabel: "Remove from this payment: {name}",
      removed: "{name} was removed.",
      unreadableKind: "Carnet does not read this kind of document, so it adds no facts.",
    },
    fact: {
      field: "Fact",
      value: "Value",
      source: "Quoted from the document",
      status: "Status",
      page: "Page {page}",
      verified: "Verified in the document",
      needsConfirmation: "Needs your confirmation",
      confirmedByYou: "Confirmed by you",
      unverified: "Not verified, not used",
      noQuote: "Entered by you, no quote",
      scanNoQuote:
        "The scan has no text layer, so there is no quote to check. Compare with the document.",
      confirmGroup: "Confirm facts from the scan",
      confirmHint:
        "This document is an image, so Carnet cannot check its quotes. Compare each value with the document and tick it when it is right. You can confirm once every value is ticked. Nothing is used until you confirm.",
      confirmLabel: "Confirm {field}: {value}",
      confirmCta: "Confirm {count} facts",
      confirmCtaOne: "Confirm 1 fact",
      confirmCtaPending: "Confirming",
      confirmDone: "Facts confirmed. Carnet checked the payment again.",
      confirmError: "The facts could not be confirmed. Nothing was changed. Try again.",
      none: "Tick every value to confirm.",
      allTicked: "{ticked} of {count} values ticked",
    },
    add: {
      title: "Add a document",
      body: "Upload a PDF, JPEG or PNG. Carnet reads it, quotes each fact from the page, and checks the payment again.",
      file: "File",
      kind: "Kind of document",
      submit: "Upload and add",
      submitPending: "Uploading",
      another: "Add another document",
      done: "{name} was added. Carnet is reading it.",
      doneKnown: "{name} was already uploaded. It is linked to this payment now.",
      errorGeneric: "The document could not be added. Nothing was changed. Try again.",
      errorChoose: "Choose a file first.",
      viewerOnly: "Only the owner can add or remove documents.",
    },
    injection: {
      title: "This document contains text that looks like instructions to an AI",
      body: "Carnet treated it as data and did not follow it. Flagged text: {match}",
    },
    send: {
      title: "Send this payment",
      sentTitle: "Approved by you, sending to Airwallex",
      sentTitleConfirmed: "Airwallex created the transfer",
      sentBody: "Its transfer status is on the payment page.",
      sentLink: "Open the payment",
      strongBody: "The evidence is strong. Sending creates the transfer in the Airwallex sandbox.",
      weakBody:
        "The evidence is weak. You can still send this payment, but Carnet records that you saw the reasons above.",
      missingBody:
        "Evidence is missing. You can still send this payment, but Carnet records that you saw the reasons above.",
      ackLabel: "I have read the reasons above and want to send this payment anyway.",
      cta: "Send payment",
      ctaAcknowledge: "Acknowledge and send",
      ctaPending: "Sending",
      done: "Sent. Airwallex has not confirmed the transfer yet.",
      errorGeneric: "The payment was not sent. Nothing was changed. Try again.",
      errorChanged:
        "The evidence changed while you were looking. Read the new reasons and try again.",
      errorFunds: "{message}",
      viewerOnly: "Only the owner can send a payment.",
      needsAck: "Tick the box to confirm you have read the reasons.",
      stale: "The evidence is out of date. Reload before sending.",
    },
    error: {
      checks: "Carnet could not load the checks. Nothing was changed.",
      documents: "Carnet could not load the documents. Nothing was changed.",
    },
    live: {
      updated: "Evidence updated: {flag}.",
    },
  },
} as const;

/** Fills `{name}` placeholders in a string from `strings.ts`. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in values) return String(values[key]);
    // A placeholder nobody filled is a bug: fail in tests and development, show the text in production.
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`fill: no value for {${key}} in "${template}"`);
    }
    return match;
  });
}

export const strings = { en } as const;

export type Locale = keyof typeof strings;
export type Strings = (typeof strings)[Locale];

/** The active locale's strings. Only `en` exists (a second locale is out of scope, M1-07). */
export const t: Strings = strings.en;

/** The BCP 47 locale passed to the `Intl` helpers in `lib/intl.ts`. */
export const locale = "en-US";
