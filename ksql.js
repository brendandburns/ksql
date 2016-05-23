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
var Client = require('node-kubernetes-client');
var readline = require('readline-history');
var Table = require('cli-table2');
var q = require('q');

var client = new Client({
    host:  '10.0.0.1:8080',
    protocol: 'http',
    version: 'v1',
});

var mybase = new alasql.Database('mybase');
mybase.exec('CREATE TABLE pods (uid TEXT, node TEXT, metadata Object, spec Object, status Object)');
mybase.exec('CREATE TABLE nodes (name TEXT, uid TEXT, metadata Object, spec Object, status Object)');
mybase.exec('CREATE TABLE containers (image TEXT, uid TEXT, restarts INT)');

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
		    var headers = [];
		    for (var field in res[0]) {
			headers.push(field);
		    }
		    var tbl = new Table({
			head: headers
		    });
		    for (var i = 0; i < res.length; i++) {
			var data = [];
			for (field in res[i]) {
			    data.push(res[i][field]);
			}
			tbl.push(data);
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

var load_pods = function() {
    var defer = q.defer();
    client.pods.get(function (err, pods) {
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
		var sql = 'INSERT INTO containers (image, uid, restarts) VALUES ("' +
		    container.image + '", "' +
		    pod.metadata.uid + '",' +
		    pod.status.containerStatuses[j].restartCount + ')';
		mybase.exec(sql);
	    }
	}
	alasql.databases.mybase.tables.pods.data = pods[0].items;
	defer.resolve();
    });
    return defer.promise;
}

var load_nodes = function() {
    var defer = q.defer();
    client.nodes.get(function (err, nodes) {
	for (var i = 0; i < nodes[0].items.length; i++) {
	    var node = nodes[0].items[i];
	    node.uid = node.metadata.uid;
	    node.name = node.metadata.name;
	}
	alasql.databases.mybase.tables.nodes.data = nodes[0].items;
	defer.resolve();
    });
    return defer.promise;
};

q.all([
    load_pods(),
    load_nodes()
]).then(function() {
    var rl = readline.createInterface({
	path: "/tmp/ksql-history",
	input: process.stdin,
	output: process.stdout,
	maxLength: 100,
	next: handle_next
    });
});


