#!/usr/bin/env python

# Copyright 2016 Brendan Burns All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import atexit
import operator
import os
import pykube
import Queue
import readline
import sqlite3
# alternate sqlite3
# from pysqlite2 import dbapi2 as sqlite3
import tabulate
import threading
import time

class Kinds:
    pod = "pod"
    service = "service"
    replication_controller = "replicationController"
    node = "node"

done = False

def handle_query(cursor, query):
    try:
        data = []
        headers = []
        result = cursor.execute(query)
        for column in result.description:
            headers.append(column[0])

        for row in result:
            rowData = []
            for field in row:
                rowData.append(field) 
            data.append(rowData)
        print tabulate.tabulate(data, headers, tablefmt='psql')
    except sqlite3.OperationalError, err:
        print err

def thread_load(q, resp, api):
    conn = sqlite3.connect(':memory:')
    cursor = conn.cursor()
    create_tables(cursor)
    load(cursor, api)
    while not done:
        try:
            query = q.get(True, 30)
            if query == '_done_':
                continue
            handle_query(cursor, query)
            resp.put(True)
        except Queue.Empty:
            pass
        load(cursor, api)
#        time.sleep(30)
    
def setup_history():
    histfile = os.path.join(os.path.expanduser("~"), ".ksql-history")
    try:
        readline.read_history_file(histfile)
        # default history len is -1 (infinite), which may grow unruly
        readline.set_history_length(1000)
    except IOError:
        pass
    atexit.register(readline.write_history_file, histfile)
    del histfile
    
def insert_metadata(cursor, kind, obj):
    uid = obj.obj['metadata']['uid']
    labels = obj.obj['metadata'].get('labels', {})
    for key, value in labels.iteritems():
        cursor.execute('''INSERT OR REPLACE INTO labels (key, value, kind, uid) VALUES (?, ?, ?, ?)''',
                       (key, value, kind, uid ))

    annotations = obj.obj['metadata'].get('annotations', {})
    for key, value in annotations.iteritems():
        cursor.execute('''INSERT OR REPLACE INTO annotations (key, value, kind, uid) VALUES (?, ?, ?, ?)''',
                       (key, value, kind, uid ))
    
def load(cursor, api):
    # TODO: need to handle things getting deleted here
    nodes = pykube.Node.objects(api)
    for node in nodes:
        insert_metadata(cursor, Kinds.node, node)
        cursor.execute('''INSERT OR REPLACE INTO nodes (uid, name, ip) VALUES(?, ?, ?)''',
                       (node.obj["metadata"]["uid"],
                        node.name,
                        node.obj["status"]["addresses"][0]["address"])) 

    namespaces = pykube.Namespace.objects(api)
    for namespace in namespaces:
        load_namespace(cursor, api, namespace.name)

def load_namespace(cursor, api, namespace):
    pods = pykube.Pod.objects(api).filter(namespace=namespace)
    for pod in pods:
        cursor.execute('''INSERT OR REPLACE INTO pods (uid, name, namespace, host) VALUES (?, ?, ?, ?)''',
                       (pod.obj['metadata']['uid'],
                        pod.name,
                        namespace,
                        pod.obj['spec']['nodeName']))
        insert_metadata(cursor, Kinds.pod, pod)
        for ix, container in enumerate(pod.obj['spec']['containers']):
            # TODO: handle container status not existing here.
            cursor.execute('''INSERT OR REPLACE INTO containers (name, image, pod_uid, restarts) VALUES (?, ?, ?, ?)''',
                           (container['name'],
                            container['image'],
                            pod.obj['metadata']['uid'],
                            pod.obj['status']['containerStatuses'][ix]['restartCount']))
            
    svcs = pykube.Service.objects(api).filter(namespace=namespace)
    for svc in svcs:
        cursor.execute('''INSERT OR REPLACE INTO services (uid, name, namespace, ip) VALUES (?, ?, ?, ?)''',
                       (svc.obj['metadata']['uid'],
                        svc.name,
                        namespace,
                        svc.obj['spec']['clusterIP']))
        insert_metadata(cursor, Kinds.service, svc)
                
    rcs = pykube.ReplicationController.objects(api).filter(namespace=namespace)
    for rc in rcs:
        cursor.execute('''INSERT OR REPLACE INTO replicationcontrollers (uid, name, namespace, replicas) VALUES (?, ?, ?, ?)''',
                       (rc.obj['metadata']['uid'], rc.name, namespace, rc.obj['spec']['replicas']))
        insert_metadata(cursor, Kinds.replication_controller, rc)
                
def create_tables(c):
    # api tables
    c.execute('''CREATE TABLE services (uid TEXT NOT NULL PRIMARY KEY, name TEXT, namespace TEXT, ip TEXT)''')
    c.execute('''CREATE TABLE pods (uid TEXT NOT NULL PRIMARY KEY, name TEXT, namespace TEXT, host TEXT)''')
    c.execute('''CREATE TABLE replicationcontrollers (uid TEXT NOT NULL PRIMARY KEY, name TEXT, namespace TEXT, replicas INTEGER)''')
    c.execute('''CREATE TABLE nodes (uid TEXT NOT NULL PRIMARY KEY, name TEXT, ip TEXT)''')

    # meta tables
    c.execute('''CREATE TABLE labels (key TEXT, value TEXT, kind TEXT, uid TEXT)''')
    c.execute('''CREATE TABLE annotations (key TEXT, value TEXT, kind TEXT, uid TEXT)''')
    c.execute('''CREATE TABLE containers (name TEXT, image TEXT, pod_uid TEXT, restarts INTEGER)''')

def handle_input(q, resp):
    try:
        query = raw_input("> ")
    except EOFError:
        return False
    if query is "q" or query is "quit":
        return False
    q.put(query)
    resp.get(True, 10)
    return True

api = pykube.HTTPClient(pykube.KubeConfig.from_file("/home/bburns/.kube/config"))
conn = sqlite3.connect(':memory:')

# Someday this might work...
# conn.enable_load_extension(True)
# conn.load_extension('./json1.so')

q = Queue.Queue(1)
resp = Queue.Queue(1)

t = threading.Thread(target=thread_load, args = (q, resp, api))
t.daemon = True
t.start()

setup_history()

while handle_input(q, resp):
    pass

done = True
q.put('_done_')
t.join()
print '\n'
