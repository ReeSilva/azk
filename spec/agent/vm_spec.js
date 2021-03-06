import h from 'spec/spec_helper';
import { _, path, config, log, fsAsync } from 'azk';
import { subscribe } from 'azk/utils/postal';
import { async, promisify, all } from 'azk/utils/promises';
import { lazy_require } from 'azk';
import { net } from 'azk/utils';

var lazy = lazy_require({
  VM      : ['azk/agent/vm'],
  dhcp    : ['azk/agent/vm'],
  hostonly: ['azk/agent/vm'],
  vbm     : 'vboxmanage',
  exec    : function() {
    return promisify(lazy.vbm.command.exec, { cmultiArgs: true, context: lazy.vbm.command });
  }
});

h.describeRequireVm("Azk agent vm", function() {
  var data_path = config("agent:vm:data_disk");
  var data_test = path.join(path.dirname(data_path), "test-" + path.basename(data_path));
  var net_opts  = {};
  var opts = {
    name: "test-" + config("agent:vm:name"),
    boot: config("agent:vm:boot_disk"),
    data: data_test,
  };

  // Setups
  var remove_disk = function(file) {
    return lazy.exec("closemedium", "disk", file).catch(() => {});
  };

  var remove = function() {
    return async(this, function* () {
      var info = yield lazy.VM.info(opts.name);
      this.timeout(0);

      if (info.installed) {
        yield lazy.VM.stop(opts.name);
        yield lazy.VM.remove(opts.name);
      }

      yield remove_disk(opts.data);
      yield remove_disk(opts.data + ".tmp");

      yield fsAsync.remove(opts.data).catch(() => null);
      yield fsAsync.remove(opts.data + ".tmp").catch(() => null);
    });
  };

  before(() => {
    return async(this, function* () {
      yield remove.apply(this);

      var interfaces = yield net.getInterfacesIps();
      opts.ip = net.generateSuggestionIp(null, interfaces);

      _.merge(net_opts, {
        ip: opts.ip,
        gateway: net.calculateGatewayIp(opts.ip),
        network: net.calculateNetIp(opts.ip),
        netmask: "255.255.255.0",
      });
    });
  });
  after(remove);

  // Tests
  it("should return installed", function() {
    return h.expect(lazy.VM.isInstalled(opts.name)).to.eventually.fail;
  });

  describe("with have a vm", function() {
    var aux_tools = {
      install_vm(options = {}) {
        options = _.merge({}, opts, options);
        log.debug("will install vm with options", options);
        return async(this, function *() {
          if (this.timeout) { this.timeout(10000); }
          yield remove.apply(this);
          return h.expect(lazy.VM.init(options)).to.eventually.fulfilled;
        });
      },
      netinfo() {
        return all([lazy.hostonly.list(), lazy.dhcp.list_servers()]);
      },
      filter_dhcp(list, VBoxNetworkName) {
        return _.find(list, (server) => server.NetworkName == VBoxNetworkName);
      },
      filter_hostonly(list, name) {
        return _.find(list, (net) => net.Name == name);
      },
    };

    describe("and have a info about vm", function() {
      // Install vm and save state
      var info = {};
      before(function() {
        return aux_tools.install_vm.apply(this).then((i => info = i));
      });

      it("should configure cpus and memory", function() {
        h.expect(info).has.property("ostype").and.match(/Linux.*64/);
        h.expect(info).has.property("cpus", parseInt(config("agent:vm:cpus")));
        h.expect(info).has.property("memory", parseInt(config("agent:vm:memory")));
      });

      it("should configure network", function() {
        h.expect(info).has.property("nic1", "hostonly");
        h.expect(info).has.property("cableconnected1", true);
        h.expect(info).has.property("hostonlyadapter1").and.match(/vboxnet/);

        h.expect(info).has.property("nic2", "nat");
        h.expect(info).has.property("cableconnected2", true);
      });

      it("should forwarding ssh port", function() {
        var portrange = config("agent:portrange_start");
        h.expect(info.ssh_port).to.above(portrange - 1);
      });

      it("should connect boot and data disks", function() {
        h.expect(info).has.property("SATA-1-0", opts.data + ".link");
      });

      it("should start, stop and return vm status", function() {
        return async(this, function* () {
          this.timeout(15000);
          h.expect(yield lazy.VM.start(opts.name)).to.ok;
          h.expect(yield lazy.VM.start(opts.name)).to.fail;
          h.expect(yield lazy.VM.isRunnig(opts.name)).to.ok;
          h.expect(yield lazy.VM.stop(opts.name, true)).to.ok;
          h.expect(yield lazy.VM.isRunnig(opts.name)).to.fail;
          h.expect(yield lazy.VM.stop(opts.name)).to.fail;
        });
      });

      it("should set and get guestproperty", function() {
        return async(this, function* () {
          var result, data = "foo", key = "bar";
          // Set property
          yield lazy.VM.setProperty(opts.name, key, data, "TRANSIENT");

          // Get property
          result = yield lazy.VM.getProperty(opts.name, key);
          h.expect(result).to.eql({ Value: data });

          // Get a not set
          result = yield lazy.VM.getProperty(opts.name, "any_foo_key_not_set");
          h.expect(result).to.eql({});
        });
      });
    });

    it("should add and remove dhcp server and hostonly network", function() {
      return async(this, function* () {
        // Install vm and get infos
        var info = yield aux_tools.install_vm.apply(this, [{ dhcp: true }]);
        var data = yield aux_tools.netinfo();

        // Check for vmbox networking
        var net  = aux_tools.filter_hostonly(data[0], info.hostonlyadapter1);
        h.expect(net).to.have.property('Name', info.hostonlyadapter1);
        h.expect(net).to.have.property('IPAddress'  , net_opts.gateway);
        h.expect(net).to.have.property('NetworkMask', net_opts.netmask);

        // Check for dhcp server
        var VBoxNetworkName = net.VBoxNetworkName;
        var server = aux_tools.filter_dhcp(data[1], VBoxNetworkName);
        h.expect(server).to.have.property('lowerIPAddress', opts.ip);
        h.expect(server).to.have.property('upperIPAddress', opts.ip);

        // Removing vm, network and dhcp server
        yield remove.apply(this);
        data = yield aux_tools.netinfo();
        h.expect(aux_tools.filter_hostonly(data[0], info.hostonlyadapter1)).to.empty;
        h.expect(aux_tools.filter_dhcp(data[1], VBoxNetworkName)).to.empty;
      });
    });

    it("should add/remove hostonly network without dhcp server", function() {
      return async(this, function* () {
        // Install vm and get infos
        var info = yield aux_tools.install_vm.apply(this);
        var data = yield aux_tools.netinfo();

        // Check for vmbox networking
        var net  = aux_tools.filter_hostonly(data[0], info.hostonlyadapter1);
        h.expect(net).to.have.property('Name', info.hostonlyadapter1);
        h.expect(net).to.have.property('IPAddress'  , net_opts.gateway);
        h.expect(net).to.have.property('NetworkMask', net_opts.netmask);

        // Networking configure guest ip
        var result, key_base = "/VirtualBox/D2D/eth0";
        result = yield lazy.VM.getProperty(opts.name, `${key_base}/address`);
        h.expect(result).to.eql({ Value: net_opts.ip });
        result = yield lazy.VM.getProperty(opts.name, `${key_base}/netmask`);
        h.expect(result).to.eql({ Value: net_opts.netmask });
        result = yield lazy.VM.getProperty(opts.name, `${key_base}/network`);
        h.expect(result).to.eql({ Value: net_opts.network });

        // Check if dhcp server is disabled
        var VBoxNetworkName = net.VBoxNetworkName;
        h.expect(aux_tools.filter_dhcp(data[1], VBoxNetworkName)).to.empty;

        // Removing vm and network interface
        var msgs, wait_msgs = h.wait_msgs("agent.#", (msg, msgs) => msgs.length >= 2);
        yield remove.apply(this);

        data = yield aux_tools.netinfo();
        msgs = yield wait_msgs;
        h.expect(aux_tools.filter_hostonly(data[0], info.hostonlyadapter1)).to.empty;
        h.expect(msgs).to.length(2);
      });
    });
  });

  describe("with a vm is running", function() {
    this.timeout(10000);
    var name = config("agent:vm:name");
    var data = "";
    var _subscription;

    before(() => {
      _subscription = subscribe('agent.#', (event) => {
        if (event.type == "ssh" && (event.context == "stdout" || event.context == "stderr")) {
          data += event.data.toString();
        }
      });
    });
    after(() => {
      _subscription.unsubscribe();
    });

    beforeEach(() => {
      data = "";
    });

    it("should return error if vm not exist", function() {
      return h.expect(lazy.VM.ssh("not-exist")).to.eventually.rejectedWith(/vm is not running/);
    });

    it("should execute a ssh command", function() {
      var result = lazy.VM.ssh(name, "sleep 0.5; uptime");
      return result.then(function(code) {
        h.expect(data).to.match(/load average/);
        h.expect(code).to.equal(0);
      });
    });

    it("should return code to execute ssh command", function() {
      return h.expect(lazy.VM.ssh(name, "exit 127")).to.eventually.equal(127);
    });

    it("should genereate a new screenshot file", function() {
      return async(this, function* () {
        var file = yield lazy.VM.saveScreenShot(name);
        yield h.expect(fsAsync.exists(file)).to.eventually.fulfilled;
        yield fsAsync.remove(file);
      });
    });

    it("should copy file to vm", function() {
      return async(this, function* () {
        var code;

        code = yield lazy.VM.copyFile(name, __filename, "/tmp/azk/file");
        h.expect(code).to.equal(0);

        code = yield lazy.VM.ssh(name, "cat /tmp/azk/file");
        h.expect(code).to.equal(0);
        h.expect(data).to.match(/should\scopy\sfile\sto\svm/);
      });
    });
  });
});
