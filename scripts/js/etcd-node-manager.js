const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({colorize: true})
  ]
});
const Promise = require('bluebird');
const fetch = require('node-fetch');
const Etcd = require('node-etcd');
// const sleep = require('sleep');
const { exec, spawn, execSync } = require('child_process');
const Cluster = require('./classes/cluster');
const api = require('./util/api');
const request = require('./util/request');

// Configure AWS
AWS.config.setPromisesDependency(Promise);

class EtcdNodeManager {

  constructor(instanceId = null, backupBucket = null, backupKey = null, backupInterval = null, dataDir = null, tagName = null, tagValue = null) {

    this.CLUSTER_STATE = {
      NEW: 'new',
      EXISTING: 'existing'
    };
    this.ERRORS = {
      QUEUE_NOT_FOUND: 'Etcd lifecycle queue undefined',
      MEMBER_NOT_FOUND: 'Member not found',
      MEMBER_REMOVE_FAILED: "Member failed to be removed",
      INVALID_MESSAGE_TYPE: "Message was not an 'autoscaling:EC2_INSTANCE_TERMINATING' message.  Deleting... ",
      EMPTY_MESSAGE: "Message contains no data",
      LIFECYCLE_ACTION_NOT_FOUND: 'Lifecycle action not found'
    };
    this.instanceId = instanceId;
    this.backupBucket = backupBucket;
    this.backupKey = backupKey;
    this.backupInterval = backupInterval;
    this.dataDir = dataDir;
    this.initialCluster = null;
    this.initialClusterState = this.CLUSTER_STATE.NEW;
    this.initialCluster = [];
    this.terminationQueue = null;
    this.sqs = new AWS.SQS();
    this.asg = new AWS.AutoScaling();
    this.lifeCyclePollInterval = 5000;
    this.tagName = tagName;
    this.tagValue = tagValue;

    this.getNodeState = this.getNodeState.bind(this);
    this.getClusterMembers = this.getClusterMembers.bind(this);
    this.addClusterMember = this.addClusterMember.bind(this);
    this.removeClusterMember = this.removeClusterMember.bind(this);
    this.queryClusterState = this.queryClusterState.bind(this);
    this.buildCluster = this.buildCluster.bind(this);
    this.execEtcd = this.execEtcd.bind(this);
    this.backupService = this.backupService.bind(this);
    this.backupNode = this.backupNode.bind(this);
    this.retrieveNodeBackup = this.retrieveNodeBackup.bind(this);
    this.restoreNode = this.restoreNode.bind(this);
    this.deleteSqsMessage = this.deleteSqsMessage.bind(this);
    this.startNode = this.startNode.bind(this);
    this.startLifeCycleListener = this.startLifeCycleListener.bind(this);
    this.start = this.start.bind(this);
  }

  getNodeState(instance) {
    logger.info(`Getting current node state for ${instance.InstanceId}`);
    const {url, options} = api.queryNodeState(instance);
    return request(url, options)
  };

  getClusterMembers(instance) {
    logger.info(`Getting cluster peers.`);
    const {url, options} = api.getClusterMembers(instance);
    return request(url, options)
  }

  addClusterMember(instance, memberData) {
    logger.info(`Adding node ${instance.InstanceId} to etcd cluster`);
    const {url, options} = api.addClusterMember(instance, memberData);
    return request(url, options)
  };

  removeClusterMember(instance, memberId) {
    logger.info(`Removing cluster member ${memberId}`);
    const {url, options} = api.removeClusterMember(instance, memberId);
    return request(url, options)
  }

  execEtcd() {

    const etcd = exec('etcd');

    etcd.stdout.on('data', (data) => {
      logger.info(`${data}`);
    });

    etcd.stderr.on('data', (data) => {
      logger.warn(`${data}`);
    });

    etcd.on('exit', function (code, signal) {
      logger.info(`etcd process exited with code ${code} and signal ${signal}`);
    });

  };

  backupNode() {

    execSync('etcdctl snapshot save /backup/snapshot.db');

    const s3 = new AWS.S3({
      apiVersion: '2006-03-01',
      params: {
        Bucket: this.backupBucket,
        Key: this.backupKey,
        Body: fs.readFileSync('/backup/snapshot.db')
      }
    });

    return s3.putObject().promise();
  };

  retrieveNodeBackup() {

    const s3 = new AWS.S3({
      apiVersion: '2006-03-01',
      params: {
        Bucket: this.backupBucket,
        Key: this.backupKey
      }
    });

    return s3.getObject().promise();
  };

  async restoreNode() {
    logger.info('Trying to restoring node from backup...');
    try {
      let response = await this.retrieveNodeBackup();
      if (response !== null) {
        logger.info('Response in not null.  Saving file...');
        fs.writeFileSync('/backup/restore.db', response.Body, {mode: '0550'});
        logger.info('File saved to /backup/restore.db');
      }
    }
    catch (err) {
      logger.info('No backup found...');
      logger.error(err);
    }
  }

  async backupService(cluster) {

    const instance = await cluster.getInstance();

    if (!instance) throw new Error('Instance is undefined');

    logger.info('Starting backup service...');
    setInterval(async () => {

      const nodeState = await this.getNodeState(instance);

      if (nodeState.state === 'StateLeader') {
        logger.info(`${instance.InstanceId} is the leader.  Backing up.`);

        try {
          let response = await this.backupNode();
          logger.info(`${instance.InstanceId} backup successful.`)
        }
        catch (err) {
          logger.error(`${instance.InstanceId} failed backup. ${err}`);
        }
      }
    }, this.backupInterval);
  }

  async deleteSqsMessage(queueUrl, receiptHandle) {

    logger.info('Deleting message: ' + receiptHandle);
    const deleteParams = {
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle
    };

    const res = await this.sqs.deleteMessage(deleteParams).promise();
    logger.info(`Message ${receiptHandle} deleted successfully`);
    return res;
  };

  async getEtcdLifeCycleQueue() {

    return this.sqs.listQueues()
      .promise()
      .then(res => {

        logger.info(res);
        const queueUrl = res.QueueUrls.find(function (url) {
          return url.indexOf('etcd-lifecycle-queue');
        });

        logger.info(queueUrl);

        if (queueUrl == "") {
          throw new Error('Etcd Lifecycle Queue not found.')
        }

        return queueUrl;
      })
      .catch(err => {
        throw new Error(err);
      })
  };

  async queryClusterState(instance, localInstance) {

    let nodeState = null;

    // If the current instance has no IP... skip it
    logger.info('Checking for IP...');
    if (instance.PrivateIpAddress == null) {

      logger.info(`No ip found for instance ${instance.InstanceId}.`);
      return;
    }

    // Store initial cluster ip
    logger.info(`Storing cluster machine ip.`);
    this.initialCluster.push(`${instance.InstanceId}=http://${instance.PrivateIpAddress}:2380`);
    logger.info(`Cluster now set to ${this.initialCluster.join(', ')}`);


    // If the current instance is THIS instance... skip it
    logger.info('Checking if currently iterating on this machine...');
    if (instance.PrivateIpAddress === localInstance.PrivateIpAddress) {
      logger.info('Yep.  Etcd not running yet.  Move onto the next member');
      return;
    }

    try {

      nodeState = await this.getNodeState(instance);
      logger.info(nodeState);

    }
    catch (err) {

      logger.info(`${instance.InstanceId}: http://${instance.PrivateIpAddress}:2379/v2/stats/self: ${err}`);
      return;
    }

    logger.info('Checking for leader...');
    if (nodeState.leaderInfo.leader == "") {
      logger.info(`${instance.InstanceId}: http://${instance.PrivateIpAddress}:2379/v2/stats/self: alive, no leader`);
      return;
    }

    // Log who our leader is
    logger.info(`${instance.InstanceId}: http://${instance.PrivateIpAddress}:2379/v2/stats/self: has leader + ${nodeState.leaderInfo.leader}`);

    if (this.initialClusterState !== this.CLUSTER_STATE.EXISTING && nodeState.state === 'StateLeader') {
      this.initialClusterState = this.CLUSTER_STATE.EXISTING;

      // inform the node that we found about the new node we're about to add so that
      // when etcd starts we can avoid etcd thinking the cluster is out of sync
      // logger.info(`joining cluster: ${localInstance.InstanceId}`);

      try {

        const params = {
          Name: localInstance.InstanceId,
          PeerURLs: [`http://${localInstance.PrivateIpAddress}:2380`]
        };

        logger.info(params);

        let response = await this.addClusterMember(instance, params);

      }
      catch (e) {

        logger.error(e);
      }
    }
  };

  async buildCluster(cluster = new Cluster({tagName: this.tagName, tagValue: this.tagValue})) {

    let localInstance = null;
    let members = null;

    try {
      localInstance = await cluster.getInstance();
      members = await cluster.getMembers()
    }
    catch (err) {

      logger.error(err);
    }

    // Check for members
    for (let member of members) {
      let response = await this.queryClusterState(member, localInstance);
    }
  };

  startNode() {

    return new Promise(async (res, rej) => {

      if (!this.backupBucket) throw new Error('No backup bucket was defined.  Please set the "ETCD_BACKUP_BUCKET" env var or program flag');
      if (!this.backupKey) throw new Error('No backup key was defined.  Please set the "ETCD_BACKUP_KEY" env var or program flag');

      let c = new Cluster({instanceId: this.instanceId, tagName: this.tagName, tagValue: this.tagValue});
      let localInstance = null, asg = null;

      try {
        localInstance = await c.getInstance();
        logger.info(JSON.stringify(localInstance));
        asg = await c.getAutoScalingGroup();
        await this.buildCluster({...c, tagValue: localInstance});
      }
      catch (e) {

        logger.error(e);
      }

      let shouldTryToRestore = false;
      if (this.initialClusterState === this.CLUSTER_STATE.NEW) {

        if (fs.existsSync(path.join(this.dataDir, "member"))) {

          logger.info(`${path.join(this.dataDir, "member")} exists.`)
        }
        else {

          shouldTryToRestore = true;
        }
      }


      // Setup and start etcd
      process.env.ETCD_NAME = localInstance.InstanceId;
      process.env.ETCD_DATA_DIR = this.dataDir;
      process.env.ETCD_ELECTION_TIMEOUT = 1200;
      process.env.ETCD_ADVERTISE_CLIENT_URLS = `http://${localInstance.PrivateIpAddress}:2379`;
      process.env.ETCD_LISTEN_CLIENT_URLS = `http://0.0.0.0:2379`;
      process.env.ETCD_LISTEN_PEER_URLS = `http://0.0.0.0:2380`;
      process.env.ETCD_INITIAL_CLUSTER_STATE = this.initialClusterState;
      process.env.ETCD_INITIAL_CLUSTER = this.initialCluster.join(',');
      process.env.ETCD_INITIAL_ADVERTISE_PEER_URLS = `http://${localInstance.PrivateIpAddress}:2380`;
      process.env.ETCD_CLIENT_CERT_AUTH = false;
      process.env.ETCDCTL_API = 3;
      // process.env.ETCDCTL_CA_FILE=/etc/ssl/certs/ca.pem
      // process.env.ETCDCTL_CERT_FILE=/etc/ssl/certs/etcdctl.pem
      // process.env.ETCDCTL_KEY_FILE=/etc/ssl/certs/etcdctl-key.pem
      process.env.ETCDCTL_ENDPOINT = `http://127.0.0.1:4001,http://127.0.0.1:2378,http://127.0.0.1:2379,http://127.0.0.1:2380`;
      process.env.ETCD_CLIENT_CERT_AUTH = false;

      if (asg !== null) {
        process.env.ETCD_INITIAL_CLUSTER_TOKEN = asg.AutoScalingGroupARN;
      }

      if (shouldTryToRestore) {
        logger.info('Should restore set.');

        try {
          let response = await this.restoreNode();

          logger.info('Etcd restore is running...');
          execSync('etcdctl snapshot restore /backup/restore.db \
           --name ' + process.env.ETCD_NAME + '\
           --initial-cluster ' + process.env.ETCD_INITIAL_CLUSTER + '\
           --initial-cluster-token ' + process.env.ETCD_INITIAL_CLUSTER_TOKEN + '\
           --initial-advertise-peer-urls ' + process.env.ETCD_INITIAL_ADVERTISE_PEER_URLS + '\
           --data-dir ' + process.env.ETCD_DATA_DIR);
          logger.info('Node restored.');
        }
        catch (err) {

        }
      }

      // Start the Backup Service
      this.backupService(c);
      res();
    });
  };

  async startLifeCycleListener() {

    const queueUrl = await this.getEtcdLifeCycleQueue();
    const params = {
      AttributeNames: [
        "SentTimestamp"
      ],
      MaxNumberOfMessages: 1,
      MessageAttributeNames: [
        "All"
      ],
      QueueUrl: queueUrl,
      VisibilityTimeout: 0,
      WaitTimeSeconds: 0
    };

    let messageBody = null, receiptHandle = null;

    setInterval(async () => {

      try {

        let res = await this.sqs.receiveMessage(params).promise();

        logger.info(JSON.stringify(res));

        // Check for 'Messages' property
        if (!res.hasOwnProperty('Messages')) return;

        receiptHandle = res.Messages[0].ReceiptHandle;
        messageBody = JSON.parse(res.Messages[0].Body);

        // Is instance terminating message
        if (messageBody.LifecycleTransition !== 'autoscaling:EC2_INSTANCE_TERMINATING') {
          res = await this.deleteSqsMessage(queueUrl, receiptHandle);
          return;
        }

        logger.info(`Removing instance ${messageBody.EC2InstanceId} from Etcd members`);

        // Get the cluster members
        res = await this.getClusterMembers({PrivateIpAddress: '127.0.0.1'});

        logger.info(JSON.stringify(res.members));

        // Find the member we are removing
        const member = res.members.find(function (member) {
          logger.info(member.name + ' === ' + messageBody.EC2InstanceId);
          return member.name === messageBody.EC2InstanceId;
        });

        // No Member!
        if (member === undefined) {
          await this.deleteSqsMessage(queueUrl, receiptHandle);
          throw new Error(this.ERRORS.MEMBER_NOT_FOUND);
        }

        // remove the member
        await this.removeClusterMember({PrivateIpAddress: '127.0.0.1'}, member.id);
        logger.info('Member ' + member.id + ' removed successfully.');


      }
      catch (err) {

        logger.error(err);
      }

    }, this.lifeCyclePollInterval)

  };

  start() {
    logger.info('Starting ETCD Node...');
    this.startNode()
      .then(res => {

        logger.info('Starting Lifecycle Listener...');
        this.startLifeCycleListener();

        logger.info('Starting ETCD...');
        this.execEtcd();
      });
  };

}

module.exports = EtcdNodeManager;
