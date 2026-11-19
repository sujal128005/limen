/*
 * Privacy policy and terms of use. Plain pages, written for the people who use
 * Limen, describing what the product actually does.
 */
import React from 'react';
import './home.css';

const UPDATED = '19 November 2026';

function Mark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="h3-mark">
      <path d="M6.8 29.6V20.8Q6.8 12 15.6 12H32.4Q41.2 12 41.2 20.8V25.2" fill="none" stroke="currentColor" strokeWidth="5.2" strokeLinejoin="round" />
      <path d="M4.2 32.8H23.6L21.2 38H4.2z" fill="#E2B862" />
    </svg>
  );
}

function Page({ title, children }) {
  React.useEffect(() => { document.title = `${title} | Limen`; window.scrollTo(0, 0); }, [title]);
  return (
    <div className="h3 lg">
      <header className="h3-bar scrolled">
        <div className="h3-bar-in">
          <a className="h3-brand" href="/" aria-label="Limen home"><Mark /><span>Limen</span></a>
          <div className="h3-bar-act">
            <a className="h3-link" href="/login">Sign in</a>
            <a className="h3-btn blue sm" href="/signup">Register your company</a>
          </div>
        </div>
      </header>
      <main className="lg-main">
        <p className="lg-kicker">Legal</p>
        <h1>{title}</h1>
        <p className="lg-date">Last updated {UPDATED}</p>
        {children}
        <nav className="lg-other">
          <a href="/privacy">Privacy policy</a>
          <a href="/terms">Terms of use</a>
          <a href="/">Back to Limen</a>
        </nav>
      </main>
    </div>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy policy">
      <p>
        Limen is an AI-assisted procurement platform operated by Nexara9 Ventures ("Limen", "we", "us").
        This policy explains what personal data we process when you use Limen, why, and the choices you
        have. We process personal data in line with the Digital Personal Data Protection Act, 2023 and
        the Information Technology Act, 2000.
      </p>

      <h2>1. What we collect</h2>
      <ul>
        <li><b>Account details:</b> your name, work email, company name, city and the role you hold at your company.</li>
        <li><b>Company details:</b> registered name, address, GSTIN and other identifiers you provide, and the details your company publishes to buyers or suppliers on Limen.</li>
        <li><b>Purchase records:</b> requirements and tenders you submit, supplier offers, negotiations, approvals, delivery confirmations, invoices and payment records.</li>
        <li><b>Payout details (suppliers):</b> bank account holder name, account number and IFSC. Account numbers are encrypted at rest and shown only in masked form.</li>
        <li><b>Security records:</b> sign-in times, the desk or account used for each action, and IP addresses, kept to protect accounts and to maintain the audit trail of each purchase.</li>
      </ul>
      <p>Passwords are never stored in readable form; we keep only a salted cryptographic hash.</p>

      <h2>2. Why we use it</h2>
      <ul>
        <li>To run your purchases and sales: matching requirements to suppliers, negotiating within the limits your company sets, routing approvals and settling payments.</li>
        <li>To produce the documents a purchase needs, such as purchase orders, tax invoices, delivery challans, goods receipt notes and payment advices.</li>
        <li>To keep an audit trail of who approved what, so your company can account for every purchase.</li>
        <li>To secure the service, prevent fraud and meet legal obligations, including tax record keeping.</li>
      </ul>
      <p>We do not sell personal data and we do not use it for advertising.</p>

      <h2>3. Who we share it with</h2>
      <ul>
        <li><b>The other party to your purchase.</b> A supplier sees the buyer's company name once the buyer approves an order, never before. A supplier never sees a buyer's budget or spending limit, and a buyer never sees a supplier's floor price.</li>
        <li><b>Service providers</b> who process data for us under contract: cloud hosting and database providers, Razorpay for payments and payouts, an email provider for account and order emails, and an AI model provider used to read uploaded tender documents.</li>
        <li><b>Authorities,</b> where the law requires it.</li>
      </ul>

      <h2>4. How long we keep it</h2>
      <p>
        Account data is kept while your account is active. Purchase, invoice and payment records are kept
        for at least eight years, the period Indian tax law requires for accounts and records. Security
        logs are kept for up to one year. When data is no longer needed, it is deleted or anonymised.
      </p>

      <h2>5. Cookies</h2>
      <p>
        Limen uses only cookies and browser storage that the service needs to work: keeping you signed in,
        protecting forms against cross-site requests, and remembering your display settings. We do not use
        advertising or tracking cookies.
      </p>

      <h2>6. Your rights</h2>
      <p>
        You can ask to access, correct or erase your personal data, and to withdraw consent where processing
        relies on it. Some records, such as invoices and payment records, must be kept by law even after an
        account is closed. You can also nominate another person to exercise these rights on your behalf.
      </p>

      <h2>7. Security</h2>
      <p>
        Data is encrypted in transit. Sensitive fields are encrypted at rest. Access is limited by role, and
        spending limits and approvals are enforced on our servers rather than in your browser. No system is
        perfectly secure; if we become aware of a breach affecting your data, we will notify you and the Data
        Protection Board of India as the law requires.
      </p>

      <h2>8. Demo</h2>
      <p>
        The public demos use sample companies and sample data. Anything you type into a demo may be seen by
        other visitors to the same demo, so do not enter real business or personal information there.
      </p>

      <h2>9. Contact and grievances</h2>
      <p>
        For privacy questions, requests or complaints, contact the Grievance Officer, Nexara9 Ventures, through{' '}
        <a href="https://nexara9.me" target="_blank" rel="noreferrer noopener">nexara9.me</a>. We respond within
        30 days. If you are not satisfied with our response, you may complain to the Data Protection Board of India.
      </p>

      <h2>10. Changes</h2>
      <p>We will post any change to this policy here and update the date above. Significant changes will be notified to registered users by email.</p>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms of use">
      <p>
        These terms govern your use of Limen, a procurement platform operated by Nexara9 Ventures ("Limen",
        "we", "us"). By creating an account or using Limen on behalf of a company, you agree to these terms and
        confirm you are authorised to bind that company.
      </p>

      <h2>1. The service</h2>
      <p>
        Limen helps buyers find suppliers, compare offers on total landed cost and negotiate within limits the
        buyer sets, and helps suppliers receive and fulfil orders. Payments for orders are held in escrow and
        released to the supplier when the buyer confirms delivery.
      </p>

      <h2>2. AI recommendations</h2>
      <p>
        Limen's agents read requirements, screen suppliers and negotiate offers. Their output is decision support.
        Every purchase is approved by a person at the buying company before any money is committed, and the buyer
        remains responsible for its purchasing decisions. Spending limits set by the buyer and floor prices set by
        suppliers are enforced by the platform and cannot be exceeded by an agent.
      </p>

      <h2>3. Accounts</h2>
      <ul>
        <li>You must give accurate company details, including a valid GSTIN where you supply or buy goods subject to GST.</li>
        <li>Keep your sign-in details confidential. You are responsible for activity under your account.</li>
        <li>Each person should use their own account. Roles such as sales, approver and finance exist to separate duties; do not share them.</li>
      </ul>

      <h2>4. Buyers</h2>
      <ul>
        <li>An approved purchase order is a binding order to the supplier on the terms it states.</li>
        <li>The buyer confirms receipt promptly and in good faith. Confirming receipt releases payment to the supplier.</li>
        <li>Quality disputes are raised with the supplier within the period in the purchase order, before receipt is confirmed where possible.</li>
      </ul>

      <h2>5. Suppliers</h2>
      <ul>
        <li>Listings must describe goods, specifications, certifications, prices and lead times accurately.</li>
        <li>A supplier that accepts an order delivers it as agreed and issues a valid GST tax invoice.</li>
        <li>Your floor price is private to you. Limen will not agree a price below it on your behalf.</li>
      </ul>

      <h2>6. Fees and payments</h2>
      <p>
        Limen charges a platform fee of 1.5% of the settled value of each completed order, plus applicable taxes.
        No fee is charged on an order that does not complete. Payments and payouts are processed by our payment
        partners and are subject to their terms. Taxes on the goods are the responsibility of the buyer and the
        supplier.
      </p>

      <h2>7. Acceptable use</h2>
      <p>
        Do not misuse Limen: no false listings or orders, no attempts to access another company's data, to bypass
        limits or approvals, to disrupt the service, or to use it for any unlawful purpose. We may suspend accounts
        that do.
      </p>

      <h2>8. Your data and ours</h2>
      <p>
        Your company owns the data it puts into Limen and the records of its purchases. You grant us the rights we
        need to operate the service for you, as described in our <a href="/privacy">privacy policy</a>. Limen's
        software, design and brand remain ours.
      </p>

      <h2>9. Demo</h2>
      <p>The public demos use sample companies and data, and no real money moves in them. Demo records may be reset at any time.</p>

      <h2>10. Liability</h2>
      <p>
        Limen is provided with reasonable skill and care. To the extent the law allows, we are not liable for indirect
        or consequential losses, and our total liability for any claim is limited to the platform fees you paid us in
        the twelve months before the claim. Nothing in these terms limits liability that cannot be limited by law.
      </p>

      <h2>11. Ending use</h2>
      <p>
        You may close your account at any time. We may suspend or end access for breach of these terms. Orders in
        progress will be completed or cancelled according to their terms, and records we must keep by law are retained.
      </p>

      <h2>12. Law and disputes</h2>
      <p>These terms are governed by the laws of India, and the courts of India have jurisdiction over any dispute.</p>

      <h2>13. Contact</h2>
      <p>
        Questions about these terms can be sent to Nexara9 Ventures through{' '}
        <a href="https://nexara9.me" target="_blank" rel="noreferrer noopener">nexara9.me</a>.
      </p>
    </Page>
  );
}

export function NotFound() {
  React.useEffect(() => { document.title = 'Page not found | Limen'; }, []);
  return (
    <div className="h3 lg">
      <header className="h3-bar scrolled">
        <div className="h3-bar-in">
          <a className="h3-brand" href="/" aria-label="Limen home"><Mark /><span>Limen</span></a>
        </div>
      </header>
      <main className="lg-main nf">
        <p className="lg-kicker">Error 404</p>
        <h1>This page does not exist</h1>
        <p>The link may be old or mistyped. Everything in Limen starts from the home page.</p>
        <div className="nf-act">
          <a className="h3-btn blue" href="/">Go to the home page</a>
          <a className="h3-btn ghost" href="/?demo=1">Open the buyer demo</a>
        </div>
      </main>
    </div>
  );
}
