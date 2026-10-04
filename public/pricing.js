// Force-Field Console — landing page: the pricing note is rendered from the
// deployment's capability flags (/api/health) so the copy never claims more
// than this deployment is configured to do. The static default (in the HTML)
// is the most conservative statement; JS only ever upgrades it when the
// flags say so.
(async function () {
  var note = document.getElementById("pricing-honest");
  if (!note) return;
  var flags = null;
  try {
    var res = await fetch("/api/health", { credentials: "same-origin" });
    if (res.ok) flags = await res.json();
  } catch {
    flags = null;
  }
  if (!flags || flags.ok !== true) return;
  var billing = flags.billing_configured === true;
  var prov = flags.provisioning_configured === true;
  if (billing && prov) {
    note.textContent =
      "Checkout runs through Stripe. After checkout a dedicated estate is provisioned automatically on Fly.io " +
      "(typically a few minutes; the dashboard shows every step) and armed in the same posture as the public sandbox: per-event ledger signing required, " +
      "signed attestations, gateway enforcement with tool checks, and a delegation roster you control. " +
      "You bring your own Anthropic API key for model calls.";
  } else if (billing) {
    note.textContent =
      "Checkout runs through Stripe. Automatic estate provisioning is not enabled on this deployment yet: " +
      "paid accounts get their dedicated estate by hand from Spin State Labs and the dashboard shows it as pending until then.";
  } else {
    note.textContent =
      "Honest note: paid checkout is not enabled on this deployment yet, and dedicated estates are provisioned manually. " +
      "Register on Sandbox and we will follow up — no instant paid activation is promised.";
  }
  var ctas = document.querySelectorAll("[data-upgrade]");
  for (var i = 0; i < ctas.length; i++) {
    ctas[i].textContent = billing ? "Upgrade" : "Talk to us";
  }
})();
