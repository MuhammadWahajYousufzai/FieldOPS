import type { Metadata } from "next";
import { ui } from "../ui";

export const metadata: Metadata = {
  title: "FieldOPS Privacy Policy",
  description: "Privacy information for the Yousuf Rice FieldOPS mobile application.",
};

export default function PrivacyPolicy() {
  const sectionClass = "mt-7 border-t border-slate-200 pt-6 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-black [&_p]:leading-7 [&_p]:text-slate-600 [&_li]:leading-7 [&_li]:text-slate-600 [&_li+li]:mt-2 [&_a]:font-bold [&_a]:text-blue-700";
  return <main className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 px-5 py-10 text-[#14213D] sm:px-10">
    <article className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_22px_70px_rgba(20,33,61,0.08)] sm:p-12">
      <a className="mb-10 flex items-center gap-3 text-[#14213D] no-underline" href="/"><span className={ui.logo}>FO</span><strong>Yousuf Rice FieldOPS</strong></a>
      <p className={ui.eyebrow}>Privacy policy · last updated 25 August 2026</p>
      <h1 className={ui.h1}>Work data, handled for field operations.</h1>
      <p className="border-l-4 border-blue-600 pl-5 text-lg leading-8 text-slate-600">FieldOPS is a private workforce application used by authorized Yousuf Rice personnel. It does not sell data, display advertising, or use personal data for unrelated consumer profiling.</p>

      <section className={sectionClass}><h2>Data FieldOPS collects</h2><ul className="list-disc pl-6">
        <li><strong>Account and employment data:</strong> work email, employee name, role, manager, and assigned territories or outlets.</li>
        <li><strong>Precise location:</strong> current visit/order coordinates and quality-checked route points from Start work until Finish session. The organization can configure the movement and timing thresholds used to capture the route.</li>
        <li><strong>Visit evidence:</strong> photos, audio notes, visit outcomes, notes, timestamps, and outlet distance checks.</li>
        <li><strong>Orders and customers:</strong> customer/shop name and optional phone/address, products, quantities, prices, notes, and capture location.</li>
        <li><strong>Team and deal data:</strong> work messages between a salesperson and manager, configured work phone/WhatsApp numbers, customer opportunity names, stages, working values, next actions, follow-up dates, and notes.</li>
        <li><strong>Operational records:</strong> attendance, assigned completion, sync status, and security/audit events.</li>
      </ul></section>

      <section className={sectionClass}><h2>How the data is used</h2><p>Data is used only to provide attendance, route history, territory enforcement, outlet assignment, visit verification, order capture, team communication, customer opportunity follow-up, offline synchronization, management reporting, troubleshooting, fraud prevention, and account security.</p></section>

      <section className={sectionClass}><h2>Optional screen-lock continuity</h2><p>Foreground route recording works while FieldOPS is open. A salesperson can separately choose screen-lock continuity in Profile and grant “Always” or background access so route recording can continue when the screen is locked or another app is open. It runs only during an active work session and stops at Finish session or sign out. Denying or revoking this optional permission does not block field work; route recording falls back to times when FieldOPS is open. Phone power settings, force-quitting the app, and operating-system limits can still create honest gaps.</p></section>

      <section className={sectionClass}><h2>Storage, sharing, and security</h2><p>Data is transmitted over encrypted HTTPS connections to the organization’s self-hosted Appwrite system. Access is limited to authorized personnel according to their role and work scope. Evidence files are private, and the mobile sign-in credential is kept in the phone’s protected credential store. FieldOPS does not sell data or share it with advertisers or data brokers.</p></section>

      <section className={sectionClass} id="data-deletion"><h2>Request account or data deletion</h2><p>Email <a href="mailto:support@ssricemills.com?subject=FieldOPS%20data%20deletion%20request">support@ssricemills.com</a> from your work email with the subject “FieldOPS data deletion request”, or ask your FieldOPS manager. Include your work email and whether you want your account, visit evidence, route history, or all eligible data deleted. We will verify the request, disable the account, and delete eligible account and operational data. Audit, security, order, or financial records may be retained only where required for legitimate business, legal, fraud-prevention, or accounting obligations, then deleted under the organization’s retention schedule.</p></section>

      <section className={sectionClass}><h2>Permissions</h2><p>While-using location is requested for territory checks, route recording, and GPS evidence. Background location is requested only when the salesperson chooses optional screen-lock continuity in Profile. Camera and microphone access are requested only when required visit evidence is captured. FieldOPS does not access photos or recordings unrelated to a visit.</p></section>

      <section className={sectionClass}><h2>Children</h2><p>FieldOPS is an enterprise workforce tool and is not intended for children.</p></section>

      <section className={sectionClass}><h2>Contact</h2><p>For a privacy request, contact your Yousuf Rice FieldOPS administrator or email <a href="mailto:support@ssricemills.com">support@ssricemills.com</a>.</p></section>
    </article>
  </main>;
}
