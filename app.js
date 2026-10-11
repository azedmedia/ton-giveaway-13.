const claimedEl = document.getElementById("claimed");
const remainingEl = document.getElementById("remaining");
const progressEl = document.getElementById("progress");
const percentEl = document.getElementById("progress-percent");
const form = document.getElementById("claim-form");
const addressInput = document.getElementById("address");
const submitBtn = document.getElementById("submit-btn");
const notice = document.getElementById("notice");
const fullState = document.getElementById("full-state");
const claimCard = document.getElementById("claim-card");

function showNotice(message, type) {
  notice.textContent = message;
  notice.className = "notice show " + type;
}
function setFull() {
  form.hidden = true;
  fullState.hidden = false;
  remainingEl.textContent = "All slots filled";
  remainingEl.style.color = "#91a8c2";
  submitBtn.disabled = true;
}
function updateStatus(data) {
  const claimed = Math.min(13, Number(data.claimed) || 0);
  const remaining = Math.max(0, 13 - claimed);
  claimedEl.textContent = claimed;
  remainingEl.textContent = remaining + (remaining === 1 ? " slot left" : " slots left");
  const percent = Math.round((claimed / 13) * 100);
  progressEl.style.width = percent + "%";
  percentEl.textContent = percent + "%";
  if (data.full || remaining === 0) setFull();
}
async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    updateStatus(await response.json());
  } catch {
    remainingEl.textContent = "Status temporarily unavailable";
  }
}
document.getElementById("clear-address").addEventListener("click", () => {
  addressInput.value = "";
  addressInput.focus();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = addressInput.value.trim();
  if (!address) {
    showNotice("Please paste your TON wallet address.", "error");
    addressInput.focus();
    return;
  }
  submitBtn.disabled = true;
  submitBtn.querySelector("span").textContent = "Submitting…";
  notice.className = "notice";
  try {
    const response = await fetch("/api/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address })
    });
    const result = await response.json();
    if (response.status === 201 && result.success) {
      showNotice("Slot " + result.slot + " of 13 secured. " + result.message, "success");
      addressInput.value = "";
      await refreshStatus();
      if (result.remaining === 0) setFull();
    } else if (result.full || response.status === 410) {
      showNotice("Reward Fully Claimed. All 13 slots have been filled.", "error");
      await refreshStatus();
      setFull();
    } else {
      showNotice(result.error || "Unable to submit your address. Please try again.", "error");
      await refreshStatus();
    }
  } catch {
    showNotice("Connection error. Please check your internet and try again.", "error");
  } finally {
    if (!fullState.hidden) {
      submitBtn.disabled = true;
    } else {
      submitBtn.disabled = false;
      submitBtn.querySelector("span").textContent = "Claim my slot";
    }
  }
});
refreshStatus();
setInterval(refreshStatus, 15000);
