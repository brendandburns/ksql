/*
 Copyright 2016 Brendan Burns All rights reserved.

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

var alasql = require('alasql');
var fs = require('fs');
var http = require('http');
var yaml = require('js-yaml');
var Client = require('node-kubernetes-client');
var path = require('path');
var q = require('q');
var readline = require('readline-history');
var Table = require('cli-table2');
var url = require('url');


var findByName = function(contexts, contextName) {
  for (var i = 0; i < contexts.length; i++) {
    if (contexts[i].name == contextName) {
      return contexts[i];
    }
  }
  return null;
};

var clientFromURL = function(urlString) {
  var host = url.parse(urlString);

  return new Client({
    host: host.host,
    protocol: host.protocol.substr(0, host.protocol.length - 1),
    version: 'v1'
  });
};

var promptForClient = function() {
  var d = q.defer();
  var rl = readline.createInterface({
    path: "/tmp/ksql-answer",
    input: process.stdin,
    output: process.stdout,
    maxLength: 10,
    next: (rli) => {
      rli.setPrompt("Server URL: ");
      rli.prompt();
      rli.on('line', function(answer) {
        d.resolve(clientFromURL(answer));
        rli.close();
      });
    },
  });

  return d.promise;
};

var connect = function() {
  var d = q.defer();
  fs.readFile(process.env.HOME + "/.kube/config", function(err, data) {
    if (err != null) {
      if (err.code == 'ENOENT') {
        promptForClient().then(function(client) {
            d.resolve(client);
        }).done();
      } else {
        d.reject(err);
      }
    return;
    } else {
      var doc = yaml.safeLoad(data);
      var contextName = doc["current-context"];
      console.log('Loading current context: "' + contextName + '"');
      var context = findByName(doc.contexts, contextName);
      var cluster = findByName(doc.clusters, context.context.cluster);
      var client = clientFromURL(cluster.cluster.server);

      var user = findByName(doc.users, context.context.user);
      if (user && user.user.token && user.user.token != 'none') {
        client.token = user.user.token;
      }
      d.resolve(client);
    }
  });
  return d.promise;
};

var mybase = new alasql.Database('mybase');

var create_tables = function(db) {
  db.exec('CREATE TABLE pods (uid TEXT, node TEXT, metadata Object, spec Object, status Object)');
  db.exec('CREATE TABLE nodes (name TEXT, uid TEXT, metadata Object, spec Object, status Object)');
  db.exec('CREATE TABLE services (name TEXT, uid TEXT, metadata Object, spec Object, status Object)');
  db.exec('CREATE TABLE containers (image TEXT, uid TEXT, restarts INT)');
};

var process_result = function(res) {
  var headers = [];
  for (var field in res[0]) {
    headers.push(field);
  }
  var table = [];
  for (var i = 0; i < res.length; i++) {
    var data = [];
    for (field in res[i]) {
      data.push(res[i][field]);
    }
    table.push(data);
  }
  return {
    'headers': headers,
    'data': table
  };
};

var handle_next = function(rli) {
  rli.setPrompt('> ');
  rli.prompt();
  rli.on('line', function(line) {
    if (line && line.length != 0) {
      try {
        var res = mybase.exec(line);
        if (res.length == 0) {
          console.log("[]");
        } else {
          var data = process_result(res);
          var tbl = new Table({
            head: data.headers
          });
          for (var i = 0; i < data.data.length; i++) {
            tbl.push(data.data[i]);
          }
          console.log(tbl.toString());
        }
      } catch (ex) {
        console.log(ex);
      }
    }
    rli.prompt();
  }).on('close', function() {
    console.log('shutting down.');
    process.exit(0);
  });
};

var load_pods = function(client) {
  var defer = q.defer();
  client.pods.get(function (err, pods) {
    if (err != null) {
        defer.reject(err);
        return;
    }
    var containers = [];
    for (var i = 0; i < pods[0].items.length; i++) {
      var pod = pods[0].items[i];
      pod.uid = pod.metadata.uid;
      pod.node = pod.spec.nodeName;
      for (var j = 0; j < pod.spec.containers.length; j++) {
        var container = pod.spec.containers[j];
        var restarts = 0;
        if (pod.status.containerStatuses[j].restartCount) {
          restarts = pod.status.containerStatuses[j].restartCount;
        }
        containers.push({
          'image': container.image,
          'uid': pod.metadata.uid,
          'restarts': pod.status.containerStatuses[j].restartCount
        });
      }
    }
    alasql.databases.mybase.tables.containers.data = containers;
    alasql.databases.mybase.tables.pods.data = pods[0].items;
    defer.resolve();
  });

  return defer.promise;
};

var generic_load = function(fn, db) {
  var defer = q.defer();
  fn(function(err, result) {
    if (err != null) {
      defer.reject(err);
      return;
    }
    for (var i = 0; i < result[0].items.length; i++) {
      var res = result[0].items[i];
      res.uid = res.metadata.uid;
      res.name = res.metadata.name;
    }
    db.data = result[0].items;
    defer.resolve();
  });
  return defer.promise;
};

var load_services = function(client) {
  return generic_load(client.services.get, alasql.databases.mybase.tables.services);
};

var load_nodes = function(client) {
  return generic_load(client.nodes.get, alasql.databases.mybase.tables.nodes);
};

var load = function (client) {
  return q.all([
    load_pods(client),
    load_nodes(client),
    load_services(client)
  ])
};

create_tables(mybase);

var client = null;

connect().then(
    function(cl) {
	client = cl;
	return load(client);
    }
).then(
  function() {
    var rl = readline.createInterface({
      path: "/tmp/ksql-history",
      input: process.stdin,
      output: process.stdout,
      maxLength: 100,
      next: handle_next
    });
	  setTimeout(function() { load(client); }, 10000);
  }
).done();

var handle_request = function(req, res) {
  var u = url.parse(req.url, true);
  if (u.pathname.startsWith('/api')) {
    handle_api_request(req, res, u);
  } else {
    handle_static_request(u, res);
  }
};

var handle_api_request = function(req, res, u) {
  var query = u.query['query'];
  if (query) {
    try {
      var qres = mybase.exec(query);
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      var obj = [];
      if (qres.length > 0) {
        obj = process_result(qres);
      }
      res.end(JSON.stringify(obj, null, 2));
    } catch (ex) {
      res.statusCode = 500;
      res.end('error: ' + ex);
    }
  } else {
    res.statusCode = 400;
    res.end('missing query');
  }
};

var handle_static_request = function(u, res) {
  var fp = '.' + u.pathname;
  if (fp == './' || fp == '.') {
	  fp = './index.html';
  }
  if (fp.indexOf('..') != -1) {
    res.statusCode = 400;
    res.end('.. is not allowed in paths');
    return;
  }
  var contentType = 'text/plain';
  switch (path.extname(fp)) {
    case '.js':
      contentType = 'text/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
    case '.html':
      contentType = 'text/html';
      break;
  }

  fs.readFile(fp, function(err, content) {
    if (err) {
      if (err.code == 'ENOENT') {
        res.statusCode = 404;
        res.end('file not found: ' + fp);
      } else {
        res.statusCode = 500;
        res.end('internal error: ' + err);
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content, 'utf-8');
  });
};

if (process.argv.length > 2 && process.argv[2] == 'www') {
  var server = http.createServer(handle_request);

  server.listen(8090, function() {
	  console.log('Server running on 0.0.0.0:8090');
  });
}


