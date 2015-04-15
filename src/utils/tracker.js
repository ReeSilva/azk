import Azk from 'azk';
import { _, config, async, path } from 'azk';
import { calculateHash } from 'azk/utils';
var os = require('os');
var osName = require('os-name');
var InsightKeenIo = require('insight-keen-io');
var qfs   = require('q-io/fs');

export class Tracker {

  constructor(opts) {
    opts = _.merge({}, {
      projectId: config('tracker:projectId'),
      writeKey: config('tracker:writeKey'),
      use_fork: true
    }, opts);

    this.insight = new InsightKeenIo(opts);
  }

  loadMetadata() {
    return async(this, function* () {
      var cpu_obj    = os.cpus();
      var cpu_info   = cpu_obj[0].model;
      var cpu_count  = cpu_obj.length;
      var arch_type  = os.arch();
      var totalmem   = Math.floor(os.totalmem() / 1024 / 1024);
      var os_name    = osName();

      this._data = {
        // keen addons
        "keen" : {
          "addons" : [{
            "name" : "keen:ip_to_geo",
            "input" : {
              "ip" : "meta.ip_address"
            },
            "output" : "meta.ip_geo_info"
          }],

          // Two time-related properties are included in your
          //  event automatically. The properties “keen.timestamp”
          //  and “keen.created_at” are set at the time your event
          //  is recorded. You have the ability to overwrite the
          //  keen.timestamp property. This could be useful, for example,
          //  if you are backfilling historical data.
          //  Be sure to use ISO-8601 Format.
          //
          //  - keen.io/docs/event-data-modeling/event-data-intro/#id9
          //
          // > (new Date(2011, 10, 11, 9, 11, 11, 111)).toISOString()
          //    '2011-11-11T11:11:11.111Z'
          'timestamp': (new Date()).toISOString(),
        },
        meta: {
          "ip_address"      : "${keen.ip}",
          "agent_session_id": yield Tracker.loadAgentSessionId(),
          "command_id"      : yield Tracker.loadCommandId(),
          "user_id"         : yield Tracker.loadTrackerUserId(),
          "azk_version"     : Azk.version,

          // device config
          "device_info": {
            os          : os_name,
            proc_arch   : arch_type,
            total_memory: totalmem,
            cpu_info    : cpu_info,
            cpu_count   : cpu_count
          }
        }
      };
    });
  }

  track(subject, data_to_add = null) {
    return async(this, function* () {

      // mergin meta info inside incoming event data
      if (data_to_add) {
        this.addData(data_to_add);
      }

      Tracker.logAnalyticsData({
        eventCollection: subject,
        data: this._data
      });

      // track data with insight
      var tracking_result = yield this.insight.track(subject, this._data);

      if (tracking_result !== 0) {
        Tracker.logAnalyticsError({stack:'[Tracker push failed:] ' + tracking_result});
        Tracker.logAnalyticsData({
          eventCollection: subject,
          data: this._data
        });
      }

      return tracking_result;
    });
  }

  addData(data) {
    this._data = _.merge({}, this._data, data);
  }

  get data() {
    return this._data;
  }

  get meta_info() {
    return this._data.meta;
  }

  set meta_info(value) {
    this._data.meta = _.merge({}, this._data.meta, value);
  }

  static generateRandomId() {
    return calculateHash(String(Math.floor(Date.now() * Math.random()))).slice(0, 8);
  }

  static loadData(key) {
    return async(function* () {
      // load tracker_info_data from ~/.azk/data/.azk/analytics/[key]
      var key_value;
      var tracker_info_file_path = path.join(config('paths:analytics'), key);

      try {
        if (yield qfs.exists(tracker_info_file_path)) {
          key_value = yield qfs.read(tracker_info_file_path);
        }
      } catch (err) {
        console.log('ERROR: loadRandomIdForKey:', err);
        console.log(err.stack);
      }

      return key_value;
    });
  }

  static saveData(key, value) {
    return async(this, function* () {

      // generate new id
      var analytics_path = config('paths:analytics');

      // check if dir exists
      var dirExists = yield qfs.exists(analytics_path);
      if (!dirExists) {
        yield qfs.makeDirectory(analytics_path);
      }

      // save agent_session_id to  ~/.azk/data/.azk/analytics/[key]
      var tracker_info_file_path = path.join(analytics_path, key);

      try {
        yield qfs.write(tracker_info_file_path, value);
      } catch (err) {
        console.log('ERROR: saveRandomIdForKey:', err);
        console.log(err.stack);
      }

      return value;
    });
  }

  static saveAgentSessionId() {
    var new_id = Tracker.generateRandomId();
    return Tracker.saveData('agent_session_id', new_id);
  }

  static loadAgentSessionId() {
    return Tracker.loadData('agent_session_id');
  }

  static saveCommandId() {
    var new_id = Tracker.generateRandomId();
    return Tracker.saveData('command_id', new_id);
  }

  static loadCommandId() {
    return Tracker.loadData('command_id');
  }

  static saveTrackerUserId() {
    var user_id = Tracker.generateRandomId();
    return Tracker.saveData('tracker_user_id', user_id);
  }

  static loadTrackerUserId() {
    return Tracker.loadData('tracker_user_id').then(function (result) {
      return result;
    });
  }

  static saveTrackerPermission(answer) {
    return Tracker.saveData('tracker_permission', answer);
  }

  static loadTrackerPermission() {
    return Tracker.loadData('tracker_permission').then(function (result) {
      if (typeof result === 'string') {
        return result === 'true';
      }
      return result;
    });
  }

  static checkTrackingPermission() {
    return Tracker.loadTrackerPermission().then(function (result) {
      return result;
    });
  }

  // use with CLI
  static askPermissionToTrack(cli) {
    var Helpers = require('azk/cli/command').Helpers;
    return Helpers.askPermissionToTrack(cli).then(function (result) {
      return result;
    });
  }

  static logAnalyticsError(err) {
    if (process.env.ANALYTICS_ERRORS === '1') {
      console.log('\n>>---------\n\n [Analytics:tracking:error]\n\n');
      console.log(err.stack);
    }
  }

  static logAnalyticsData(analytics_data) {
    if (process.env.ANALYTICS_DATA === '1') {
      console.log('\n>>---------\n\n [Analytics:tracking:data]\n\n', require('util').inspect(analytics_data,
      { showHidden: false, depth: null, colors: true }), '\n>>---------\n');
    }
    if (process.env.ANALYTICS_DATA === '2') {
      console.log('[Analytics:tracking] >', analytics_data.eventCollection, analytics_data.data.event_type);
    }
  }
}

var default_tracker = new Tracker();
export default default_tracker;
