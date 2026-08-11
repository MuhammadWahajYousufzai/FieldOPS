import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FieldOPS Privacy Policy",
  description: "Privacy information for the Yousuf Rice FieldOPS mobile application.",
};

export default function PrivacyPolicy() {
  return <main className="policy-page">
    <article className="policy-card">
      <a className="policy-brand" href="/"><span className="grain">FO</span><strong>Yousuf Rice FieldOPS</strong></a>
      <p className="eyebrow">Privacy policy · last updated 11 August 2026</p>
      <h1>Work data, handled for field operations.</h1>
      <p className="policy-intro">FieldOPS is a private workforce application used by authorized Yousuf Rice personnel. It does not sell data, display advertising, or use personal data for unrelated consumer profiling.</p>

      <section><h2>Data FieldOPS collects</h2><ul>
        <li><strong>Account and employment data:</strong> work email, employee name/code, role, manager, and assigned territories or outlets.</li>
        <li><strong>Precise location:</strong> current visit/order coordinates and route points about once per minute from Start work until Finish today, including while the app is in the background.</li>
        <li><strong>Visit evidence:</strong> photos, audio notes, visit outcomes, notes, timestamps, and outlet distance checks.</li>
        <li><strong>Orders and customers:</strong> customer/shop name and optional phone/address, products, quantities, prices, notes, and capture location.</li>
        <li><strong>Operational records:</strong> attendance, assigned completion, sync status, and security/audit events.</li>
      </ul></section>

      <section><h2>How the data is used</h2><p>Data is used only to provide attendance, route history, territory enforcement, outlet assignment, visit verification, order capture, offline synchronization, management reporting, troubleshooting, fraud prevention, and account security.</p></section>

      <section><h2>Background location</h2><p>Background location is collected only after the salesperson starts work and grants “Always” or background access. It lets FieldOPS keep the work route complete when the screen is locked or another app is open. Route collection stops when the salesperson taps Finish today. The phone’s settings can revoke access at any time, although route-dependent work features will then stop.</p></section>

      <section><h2>Storage, sharing, and security</h2><p>Data is transmitted over encrypted HTTPS connections to the organization’s self-hosted Appwrite system. Access is limited to authorized personnel according to their role and work scope. Evidence files are private. FieldOPS does not sell data or share it with advertisers or data brokers.</p></section>

      <section id="data-deletion"><h2>Request account or data deletion</h2><p>Email <a href="mailto:management@sherazwaqar.tech?subject=FieldOPS%20data%20deletion%20request">management@sherazwaqar.tech</a> from your work email with the subject “FieldOPS data deletion request”, or ask your FieldOPS manager. Include your employee code and whether you want your account, visit evidence, route history, or all eligible data deleted. We will verify the request, disable the account, and delete eligible account and operational data. Audit, security, order, or financial records may be retained only where required for legitimate business, legal, fraud-prevention, or accounting obligations, then deleted under the organization’s retention schedule.</p></section>

      <section><h2>Permissions</h2><p>Location is requested for territory checks and GPS evidence. Background location is requested when work tracking starts. Camera and microphone access are requested only when required visit evidence is captured. FieldOPS does not access photos or recordings unrelated to a visit.</p></section>

      <section><h2>Children</h2><p>FieldOPS is an enterprise workforce tool and is not intended for children.</p></section>

      <section><h2>Contact</h2><p>For a privacy request, contact your Yousuf Rice FieldOPS administrator or email <a href="mailto:management@sherazwaqar.tech">management@sherazwaqar.tech</a>.</p></section>
    </article>
  </main>;
}
