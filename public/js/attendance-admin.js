const $ = (id) => document.getElementById(id);

function getDistanceText(m){
  if(m === null || m === undefined) return '-';
  if(m >= 1000) return (m/1000).toFixed(2) + ' km';
  return Math.round(m) + ' m';
}

function fmtDate(dateKey){
  const [y,m,d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

function fmtTime(dt){
  if(!dt) return '-';
  return new Date(dt).toLocaleTimeString([], {
    hour:'2-digit',
    minute:'2-digit'
  });
}

function initSelectors(){
  const months = [
    ['01','January'], ['02','February'], ['03','March'],
    ['04','April'], ['05','May'], ['06','June'],
    ['07','July'], ['08','August'], ['09','September'],
    ['10','October'], ['11','November'], ['12','December']
  ];

  $('adminMonth').innerHTML = months.map(m =>
    `<option value="${m[0]}">${m[1]}</option>`
  ).join('');

  const currentYear = new Date().getFullYear();
  let years = '';
  for(let y = currentYear; y >= currentYear - 3; y--){
    years += `<option value="${y}">${y}</option>`;
  }
  $('adminYear').innerHTML = years;

  $('adminMonth').value = String(new Date().getMonth() + 1).padStart(2, '0');
  $('adminYear').value = String(currentYear);

  $('adminMonth').addEventListener('change', loadAdmin);
  $('adminYear').addEventListener('change', loadAdmin);
}

function label(r){
  if(r.outsideReason === 'On Leave') return 'On Leave';
  if(r.status === 'OUTSIDE_GEOFENCE') return 'Outside Office';
  if(r.status === 'LATE') return 'Late';
  return 'On Time';
}

async function loadAdmin(){
  const month = $('adminMonth').value;
  const year = $('adminYear').value;

  const r = await fetch(`/api/attendance/admin?month=${month}&year=${year}`, {
    cache:'no-store'
  });

  const j = await r.json().catch(()=>({}));

  if(!r.ok || !j.ok){
    $('adminSummary').textContent = j.error || 'Unable to load records.';
    return;
  }

  const s = j.summary;

  $('adminSummary').innerHTML = `
    <strong>Monthly Attendance Summary</strong><br><br>
    Total Records: ${s.total || 0}<br>
    Office Attendance: ${s.officeAttendance || 0}<br>
    • On Time: ${s.onTime || 0}<br>
    • Late: ${s.late || 0}<br><br>
    Outside Office Attendance: ${s.outsideOffice || 0}<br>
    On Leave: ${s.onLeave || 0}
  `;

  if(!j.records.length){
    $('adminRecords').innerHTML = '<div class="record-card">No records found.</div>';
    return;
  }

  $('adminRecords').innerHTML = j.records.map(r => `
    <div class="record-card">
      <strong>${r.email}</strong>
      <div class="record-meta">
        Date: ${fmtDate(r.dateKey)}<br>
        Clock In: ${fmtTime(r.clockInAt)}<br>
        Status: ${label(r)}<br>
        Distance: ${getDistanceText(r.clockInLocation?.distanceM)}<br>
        Reason: ${r.outsideReason || '-'}<br>
        Note: ${r.outsideNote || '-'}
      </div>
    </div>
  `).join('');
}

initSelectors();
loadAdmin();
