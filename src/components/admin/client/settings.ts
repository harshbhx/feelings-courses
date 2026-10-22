/** Settings: business details, legal confirmation, payment mode, site status, course addresses, password. */
import type { AdminCourse, AdminSettings, PublishStatus } from "../../../shared/types";
import { admin, asApiError } from "./api";
import { courses } from "./course-options";
import { $, fill, h, icon, ready } from "./dom";
import { clearErrors, setErrors } from "./fields";
import { notifyChanged } from "./events";
import { emptyBox, errorBox, skeleton } from "./states";
import { busy, toast } from "./ui";
import { domainView } from "../lib/domain";
import { describeError } from "../lib/errors";
import { publishView, rebuildMessage } from "../lib/publish";
import { gstinProblem, passwordProblem } from "../lib/settings";
import { courseAddresses } from "../lib/slug";
import { normalizePhone } from "../lib/students";
import { ago, istDateTime, unixNow } from "../lib/time";

let settings: AdminSettings;

const val = (name: string) => $<HTMLInputElement>(`[data-field="${name}"]`)?.value ?? "";
const set = (name: string, value: string) => {
  const el = $<HTMLInputElement>(`[data-field="${name}"]`);
  if (el) el.value = value;
};

function fillBusiness(): void {
  const b = settings.business;
  set("business.name", b.name);
  set("business.legalName", b.legalName);
  set("business.address", b.address);
  set("business.stateCode", b.stateCode || "24");
  set("business.phone", b.phone);
  set("business.whatsapp", b.whatsapp && b.whatsapp !== b.phone.replace(/\D/g, "") ? `+${b.whatsapp}` : "");
  set("business.gstin", b.gstin ?? "");
}

function renderMode(): void {
  const mode = $("[data-mode]");
  const help = $("[data-mode-help]");
  if (!mode || !help) return;
  if (settings.paymentMode === "live") {
    mode.textContent = "Live: real payments";
    help.textContent = "Students pay with real money through Razorpay. Refunds are possible for 24 hours after a payment.";
  } else if (settings.paymentMode === "test") {
    mode.textContent = "Test mode";
    help.textContent = "Razorpay test keys: checkout works, but no real money moves. Harsh switches to live keys with “npm run go-live” once the legal pages are confirmed.";
  } else {
    mode.textContent = "Not set up";
    help.textContent = "No Razorpay keys yet. Harsh adds them with the one-time setup.";
  }
}

async function renderSite(): Promise<void> {
  const root = $("[data-site]");
  if (!root) return;
  let status: PublishStatus | null = null;
  try {
    status = await admin("GET /api/admin/publish/status");
  } catch {
    status = null;
  }
  const view = status ? publishView(status) : null;
  const publish = h("button", { type: "button", class: "btn btn-secondary" }, "Publish changes");
  publish.addEventListener("click", () =>
    void busy(publish, async () => {
      try {
        const r = await admin("POST /api/admin/publish");
        const msg = rebuildMessage(r.rebuild, unixNow());
        toast(msg.text, msg.tone);
        notifyChanged();
        await renderSite();
      } catch (err) {
        toast(describeError(asApiError(err)).message, "error");
      }
    }),
  );
  const env = settings.appEnv === "production" ? "Live site" : settings.appEnv === "preview" ? "Preview copy" : "Local copy";
  fill(
    root,
    view ? h("p", { class: "set-mode", text: view.label }) : null,
    view ? h("p", { class: "field-hint", text: view.detail }) : null,
    h(
      "dl",
      { class: "kv" },
      h("dt", { text: "This copy" }),
      h("dd", { text: env }),
      h("dt", { text: "Last update" }),
      h("dd", { text: settings.lastRebuildAt ? `${ago(settings.lastRebuildAt, unixNow())}` : "Not yet" }),
      h("dt", { text: "Last backup" }),
      h("dd", { text: settings.lastBackupAt ? istDateTime(settings.lastBackupAt) : "Not yet (runs daily once set up)" }),
    ),
    view?.action ? h("div", null, publish) : null,
  );
}

function renderAddresses(list: AdminCourse[]): void {
  const root = $("[data-addresses]");
  if (!root) return;
  const shown = list.filter((c) => c.status !== "archived");
  if (!shown.length) {
    fill(root, emptyBox({ icon: "link-simple", title: "No courses yet", text: "Each course gets its own address when you create it." }));
    return;
  }
  fill(
    root,
    shown.map((c) => {
      const v = domainView(c.domainStatus, c.slug);
      return h(
        "div",
        { class: "addr-row" },
        h("div", { class: "addr-main" }, h("strong", { text: c.title }), h("span", { class: "addr-host", text: courseAddresses(c.slug).host })),
        h(
          "div",
          { class: "btn-row" },
          h("span", { class: v.tone === "live" ? "pill pill-live" : v.tone === "wait" ? "pill pill-wait" : "pill", text: v.label }),
          v.tone !== "live" ? h("a", { class: "btn btn-secondary btn-sm", href: `/admin/courses/edit?id=${c.id}#sec-address` }, "Set up", icon("arrow-right")) : null,
        ),
      );
    }),
  );
}

async function saveBusiness(form: HTMLFormElement, button: HTMLButtonElement | null): Promise<void> {
  const errors: Record<string, string> = {};
  const req = (name: string, label: string, max: number) => {
    const v = val(name).trim();
    if (!v) errors[name] = `Enter the ${label}.`;
    else if (v.length > max) errors[name] = `Keep the ${label} under ${max} characters.`;
    return v;
  };
  const name = req("business.name", "trading name", 80);
  const legalName = req("business.legalName", "legal name", 120);
  const address = req("business.address", "address", 300);
  const phone = normalizePhone(val("business.phone"));
  if (!phone) errors["business.phone"] = "Enter a 10-digit mobile number, or an international number starting with +.";
  const waRaw = val("business.whatsapp").trim();
  const wa = waRaw ? normalizePhone(waRaw) : phone;
  if (waRaw && !wa) errors["business.whatsapp"] = "Enter a 10-digit mobile number, or an international number starting with +.";
  const gstin = val("business.gstin").trim().toUpperCase();
  const gp = gstinProblem(gstin);
  if (gp) errors["business.gstin"] = gp;
  if (Object.keys(errors).length) {
    setErrors(form, errors);
    return;
  }
  clearErrors(form);
  await busy(button, async () => {
    try {
      settings = await admin("PUT /api/admin/settings", {}, {
        business: { name, legalName, address, stateCode: val("business.stateCode"), phone: phone!, whatsapp: wa!, gstin: gstin || null },
      });
      fillBusiness();
      toast("Business details saved. Publish changes to update receipts and pages.");
      notifyChanged();
      void renderSite();
    } catch (err) {
      const e = asApiError(err);
      if (Object.keys(e.fields).length) setErrors(form, e.fields);
      else toast(describeError(e).message, "error");
    }
  });
}

async function changePassword(form: HTMLFormElement): Promise<void> {
  const current = val("current");
  const next = val("next");
  const again = val("again");
  if (!current) {
    setErrors(form, { current: "Enter your current password." });
    return;
  }
  const p = passwordProblem(next, current, again);
  if (p) {
    setErrors(form, { [p.field]: p.message });
    return;
  }
  clearErrors(form);
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  await busy(button, async () => {
    try {
      await admin("POST /api/admin/password", {}, { current, next });
      form.reset();
      toast("Password changed. Other devices are signed out.");
    } catch (err) {
      const e = asApiError(err);
      if (e.code === "wrong_password") setErrors(form, { current: "That isn't the current password." });
      else if (Object.keys(e.fields).length) setErrors(form, e.fields);
      else toast(describeError(e).message, "error");
    }
  });
}

ready(() => {
  const root = $("[data-settings]");
  const loading = $("[data-loading]");
  if (!root || !loading) return;

  const load = async () => {
    fill(loading, skeleton(4, "block"));
    try {
      settings = await admin("GET /api/admin/settings");
    } catch (err) {
      fill(loading, h("div", { class: "card" }, errorBox(err, { what: "the settings", retry: () => void load() })));
      return;
    }
    loading.replaceChildren();
    root.hidden = false;
    fillBusiness();
    renderMode();
    const legal = $<HTMLInputElement>("[data-legal]");
    if (legal) legal.checked = settings.legalConfirmed;
    void renderSite();
    courses()
      .then(renderAddresses)
      .catch(() => fill($("[data-addresses]")!, h("p", { class: "card-pad field-hint", text: "Couldn't load the courses." })));
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  };

  const business = $<HTMLFormElement>("[data-business]");
  business?.addEventListener("submit", (e) => {
    e.preventDefault();
    void saveBusiness(business, $<HTMLButtonElement>("[data-business-save]"));
  });
  const password = $<HTMLFormElement>("[data-password]");
  password?.addEventListener("submit", (e) => {
    e.preventDefault();
    void changePassword(password);
  });
  const legal = $<HTMLInputElement>("[data-legal]");
  legal?.addEventListener("change", async () => {
    legal.disabled = true;
    try {
      settings = await admin("PUT /api/admin/settings", {}, { legalConfirmed: legal.checked });
      toast(settings.legalConfirmed ? "Legal pages confirmed." : "Confirmation removed: live payments stay off.");
    } catch (err) {
      legal.checked = !legal.checked;
      toast(describeError(asApiError(err)).message, "error");
    } finally {
      legal.disabled = false;
    }
  });
  void load();
});
