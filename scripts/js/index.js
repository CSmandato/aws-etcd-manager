const EtcdNodeManager = require('./etcd-node-manager');
const winston = require('winston');
const logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({colorize: true})
  ]
});
const flags = require('flags');
const DEFAULT_BACKUP_INTERVAL = 5*60*1000;
const DEFAULT_BACKUP_BUCKET = process.env.ETCD_BACKUP_BUCKET || 'etcd-dev';
const DEFAULT_BACKUP_KEY = process.env.ETCD_BACKUP_KEY || 'backup';
const DEFAULT_DATA_DIR = process.env.ETCD_DATA_DIR || '/var/lib/etcd';
const CLUSTER_TAG_NAME = process.env.CLUSTER_TAG_NAME || 'aws:autoscaling:groupName';


// Entry point for Etcd Node Manager Program
function main() {

  // Define Program flags
  flags.defineString("instance-id", "", "The instance ID of the cluster member.  If not supplied, then the instance ID is determined from this instance metadata.");
  flags.defineString("tagName", CLUSTER_TAG_NAME, "The instance tag that is common to all members of the cluster");
  flags.defineInteger("backup-interval", DEFAULT_BACKUP_INTERVAL, "How frequently to back up the etcd data to S3");
  flags.defineString("backup-bucket", DEFAULT_BACKUP_BUCKET, "The name of the bucket where the backup is stored");
  flags.defineString('backup-key', DEFAULT_BACKUP_KEY, "The name of the S3 key where the backup is stored");
  flags.defineString('data-dir', DEFAULT_DATA_DIR, "The path to the etcd data dir");
  flags.parse();

  const instanceId = flags.get('instance-id').length ? flags.get('instance-id') : null;
  const tagName = flags.get('tagName');
  const backupInterval = flags.get('backup-interval');
  const backupBucket = flags.get('backup-bucket');
  const backupKey = flags.get('backup-key');
  const dataDir = flags.get('data-dir');

  const etcdNodeManager = new EtcdNodeManager(instanceId, backupBucket, backupKey, backupInterval, dataDir, tagName);

  try {

    etcdNodeManager.start();
  }
  catch(err) {
    logger.error(err);
  }
}

main();