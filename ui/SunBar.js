/**
 * SunBar — bottom strip with hour + day-of-year sliders.
 *
 * Visible only in White-model mode. Emits `sun:config:changed`
 * { hour, dayOfYear } on every drag; ThreeOverlay's setSunConfig
 * picks it up via app.js.
 */

import { eventBus } from '../core/EventBus.js';

var DEFAULTS = { hour: 14, dayOfYear: 172 };  // June 21, 14:00

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MONTH_OFFSETS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function dayOfYearToLabel(doy) {
  doy = Math.max(1, Math.min(365, Math.round(doy)));
  for (var m = 11; m >= 0; m--) {
    if (doy > MONTH_OFFSETS[m]) {
      return MONTH_NAMES[m] + ' ' + (doy - MONTH_OFFSETS[m]);
    }
  }
  return 'Jan 1';
}

function hourToLabel(h) {
  var hh = Math.floor(h);
  var mm = Math.round((h - hh) * 60);
  if (mm >= 60) { hh += 1; mm -= 60; }
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

export class SunBar {
  constructor() {
    this._el = null;
    this._hour = DEFAULTS.hour;
    this._doy = DEFAULTS.dayOfYear;
  }

  init() {
    this._el = document.createElement('div');
    this._el.id = 'sun-bar';
    this._el.style.display = 'none';
    this._el.innerHTML =
      '<div class="sun-bar-row">' +
        '<div class="sun-bar-ctrl">' +
          '<div class="sun-bar-label">Hour <span id="sun-hour-val">' + hourToLabel(this._hour) + '</span></div>' +
          '<input type="range" id="sun-hour" min="0" max="23.5" step="0.25" value="' + this._hour + '">' +
        '</div>' +
        '<div class="sun-bar-ctrl">' +
          '<div class="sun-bar-label">Date <span id="sun-day-val">' + dayOfYearToLabel(this._doy) + '</span></div>' +
          '<input type="range" id="sun-day" min="1" max="365" step="1" value="' + this._doy + '">' +
        '</div>' +
      '</div>';
    document.body.appendChild(this._el);

    var self = this;
    document.getElementById('sun-hour').addEventListener('input', function (e) {
      self._hour = parseFloat(e.target.value);
      document.getElementById('sun-hour-val').textContent = hourToLabel(self._hour);
      self._emit();
    });
    document.getElementById('sun-day').addEventListener('input', function (e) {
      self._doy = parseInt(e.target.value, 10);
      document.getElementById('sun-day-val').textContent = dayOfYearToLabel(self._doy);
      self._emit();
    });

    eventBus.on('whitewash:changed', function (d) {
      self._el.style.display = (d && d.enabled) ? 'flex' : 'none';
    });

    // Push the initial config so the overlay's default matches the UI.
    this._emit();
  }

  _emit() {
    eventBus.emit('sun:config:changed', {
      hour: this._hour,
      dayOfYear: this._doy
    });
  }
}
