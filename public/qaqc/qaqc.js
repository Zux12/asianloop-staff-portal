// Helper: read cookie (for user email display)
function readCookie(name) {
  var cookies = (document.cookie || '').split('; ');
  for (var i = 0; i < cookies.length; i++) {
    var part = cookies[i];
    var eq = part.indexOf('=');
    if (eq > -1) {
      var key = decodeURIComponent(part.slice(0, eq));
      if (key === name) {
        return decodeURIComponent(part.slice(eq + 1));
      }
    }
  }
  return null;
}

function initUserEmail() {
  var slot = document.getElementById('userEmail');
  if (!slot) return;
  var email = readCookie('al_user_email');
  if (email) {
    slot.textContent = email;
    return;
  }
  try {
    fetch('/me', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (u) {
        if (u && u.email) slot.textContent = u.email;
      })
      .catch(function(){});
  } catch (_) {}
}

function formatDateTime(d) {
  if (!d) return '';
  var dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString();
}

// === Controlled Document Request ===
function setupModeToggle() {
  var modeSel = document.getElementById('mode');
  var projectRow = document.getElementById('projectCodeRow');
  if (!modeSel || !projectRow) return;
  var update = function () {
    if (modeSel.value === 'project') projectRow.style.display = '';
    else projectRow.style.display = 'none';
  };
  modeSel.addEventListener('change', update);
  update();
}

function setupRequestForm() {
  var form = document.getElementById('dcRequestForm');
  var msg = document.getElementById('dcRequestMessage');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.textContent = '';

    var mode = form.mode.value;
    var deptCode = form.deptCode.value;
    var docTypeCode = form.docTypeCode.value;
    var title = form.title.value;
    var projectCode = form.projectCode.value;

    if (!deptCode || !docTypeCode || !title.trim()) {
      msg.textContent = 'Please fill department, document type, and title.';
      msg.style.color = '#ffb3c1';
      return;
    }

    fetch('/api/dc/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: mode,
        deptCode: deptCode,
        docTypeCode: docTypeCode,
        title: title,
        projectCode: projectCode
      })
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        msg.textContent = data.error || 'Failed to submit request.';
        msg.style.color = '#ffb3c1';
        return;
      }
      msg.textContent = 'Request submitted successfully.';
      msg.style.color = '#8ff8c8';
      form.title.value = '';
      if (mode === 'project') form.projectCode.value = '';
      loadRequests();
    })
    .catch(function (err) {
      console.error('Request error', err);
      msg.textContent = 'Error submitting request.';
      msg.style.color = '#ffb3c1';
    });
  });
}

// === Correspondence Generator ===
function setupCorrForm() {
  var form = document.getElementById('corrForm');
  var out = document.getElementById('corrResult');
  if (!form) return;

  // default year
  var yearInput = document.getElementById('corrYear');
  if (yearInput && !yearInput.value) {
    yearInput.value = new Date().getFullYear();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    out.textContent = '';

    var recipient = form.corrRecipient.value;
    var typeCode = form.corrTypeCode.value;
    var year = form.corrYear.value;

    if (!recipient.trim()) {
      out.textContent = 'Please enter recipient code.';
      out.style.color = '#ffb3c1';
      return;
    }

    fetch('/api/dc/corr/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: recipient,
        typeCode: typeCode,
        year: year
      })
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        out.textContent = data.error || 'Failed to generate number.';
        out.style.color = '#ffb3c1';
        return;
      }
      out.textContent = 'Generated: ' + data.corrNo;
      out.style.color = '#8ff8c8';
    })
    .catch(function (err) {
      console.error('Corr error', err);
      out.textContent = 'Error generating number.';
      out.style.color = '#ffb3c1';
    });
  });
}

// === Requests & Approvals table ===
function loadRequests() {
  var tbody = document.querySelector('#requestsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="muted">Loading...</td></tr>';

  fetch('/api/dc/requests')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        tbody.innerHTML = '<tr><td colspan="8" class="muted">Failed to load requests.</td></tr>';
        return;
      }
      var items = data.items || [];
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="muted">No requests yet.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      items.forEach(function (item) {
        var tr = document.createElement('tr');

        var modeLabel = item.mode === 'project'
          ? 'Project <span class="pill-mode proj">PRJ</span>'
          : 'Corporate <span class="pill-mode corp">CORP</span>';

        var statusClass = 'status-' + (item.status || '').toUpperCase();

        tr.innerHTML =
          '<td>' + (item.assignedDocNo || '<span class="muted small">—</span>') + '</td>' +
          '<td>' + modeLabel + '</td>' +
          '<td><div class="small"><strong>' + (item.deptCode || '-') + '</strong> / ' + (item.docTypeCode || '-') + '</div></td>' +
          '<td><span class="small">' + (item.title || '') + '</span></td>' +
          '<td><div class="small">' +
            (item.originatorName ? item.originatorName + '<br>' : '') +
            '<span class="muted">' + (item.originatorEmail || '') + '</span>' +
          '</div></td>' +
          '<td><span class="status-pill ' + statusClass + '">' + item.status + '</span></td>' +
          '<td class="small">' + formatDateTime(item.createdAt) + '</td>' +
          '<td class="small"></td>';

        var actionCell = tr.lastChild;
        if (item.status === 'PENDING') {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-primary';
          btn.textContent = 'Approve & issue';
          btn.addEventListener('click', function () {
            approveRequest(item.id);
          });
          actionCell.appendChild(btn);
        } else {
          actionCell.innerHTML = '<span class="muted small">—</span>';
        }

        tbody.appendChild(tr);
      });
    })
    .catch(function (err) {
      console.error('Load requests error', err);
      tbody.innerHTML = '<tr><td colspan="8" class="muted">Error loading requests.</td></tr>';
    });
}

function approveRequest(id) {
  if (!id) return;
  if (!confirm('Issue controlled document number for this request?')) return;

  fetch('/api/dc/requests/' + encodeURIComponent(id) + '/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        alert(data.error || 'Failed to approve request.');
        return;
      }
      alert('Issued document number: ' + data.docNo);
      loadRequests();
      loadDocs();
    })
    .catch(function (err) {
      console.error('Approve error', err);
      alert('Error approving request.');
    });
}

// === MDR (docs) table & file upload ===
var currentUploadDocId = null;

function loadDocs() {
  var tbody = document.querySelector('#docsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="muted">Loading...</td></tr>';

  fetch('/api/dc/docs')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        tbody.innerHTML = '<tr><td colspan="8" class="muted">Failed to load MDR.</td></tr>';
        return;
      }
      var items = data.items || [];
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="muted">No issued documents yet.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      items.forEach(function (doc) {
        var tr = document.createElement('tr');

        var modeLabel = doc.mode === 'project'
          ? 'Project <span class="pill-mode proj">PRJ</span>'
          : 'Corporate <span class="pill-mode corp">CORP</span>';

        var fileStatus = doc.hasFile
          ? '<span class="status-pill status-APPROVED">File uploaded</span>'
          : '<span class="status-pill status-PENDING">No file</span>';

        tr.innerHTML =
          '<td><strong class="small">' + (doc.docNo || '') + '</strong></td>' +
          '<td>' + modeLabel + '</td>' +
          '<td><div class="small"><strong>' + (doc.deptCode || '-') + '</strong> / ' + (doc.docTypeCode || '-') + '</div></td>' +
          '<td><span class="small">' + (doc.title || '') + '</span></td>' +
          '<td><div class="small">' +
            (doc.originatorName ? doc.originatorName + '<br>' : '') +
            '<span class="muted">' + (doc.originatorEmail || '') + '</span>' +
          '</div></td>' +
          '<td>' + fileStatus + '</td>' +
          '<td class="small">' + formatDateTime(doc.createdAt) + '</td>' +
          '<td class="small"></td>';

        var actionCell = tr.lastChild;
        if (doc.hasFile) {
          var viewBtn = document.createElement('button');
          viewBtn.type = 'button';
          viewBtn.className = 'btn btn-ghost';
          viewBtn.textContent = 'View file';
          viewBtn.addEventListener('click', function () {
            window.open('/api/dc/docs/' + encodeURIComponent(doc.id) + '/file', '_blank');
          });
          actionCell.appendChild(viewBtn);
        } else {
          var upBtn = document.createElement('button');
          upBtn.type = 'button';
          upBtn.className = 'btn btn-primary';
          upBtn.textContent = 'Upload file';
          upBtn.addEventListener('click', function () {
            startUploadForDoc(doc.id);
          });
          actionCell.appendChild(upBtn);
        }

        tbody.appendChild(tr);
      });
    })
    .catch(function (err) {
      console.error('Load docs error', err);
      tbody.innerHTML = '<tr><td colspan="8" class="muted">Error loading MDR.</td></tr>';
    });
}

function startUploadForDoc(docId) {
  currentUploadDocId = docId;
  var input = document.getElementById('hiddenFileInput');
  if (!input) return;
  input.value = '';
  input.click();
}

function setupHiddenFileInput() {
  var input = document.getElementById('hiddenFileInput');
  if (!input) return;
  input.addEventListener('change', function () {
    if (!currentUploadDocId) return;
    if (!input.files || !input.files.length) return;

    var file = input.files[0];
    var formData = new FormData();
    formData.append('file', file);

    fetch('/api/dc/docs/' + encodeURIComponent(currentUploadDocId) + '/upload', {
      method: 'POST',
      body: formData
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          alert(data.error || 'Upload failed.');
          return;
        }
        alert('File uploaded and linked to document.');
        currentUploadDocId = null;
        loadDocs();
      })
      .catch(function (err) {
        console.error('Upload error', err);
        alert('Error uploading file.');
      });
  });
}

// === Init ===
document.addEventListener('DOMContentLoaded', function () {
  initUserEmail();

  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();

  setupModeToggle();
  setupRequestForm();
  setupCorrForm();
  setupHiddenFileInput();
  loadRequests();
  loadDocs();
});
