const AWS = require('aws-sdk');
const fs = require('fs');
const winston = require('winston');
const Promise = require('bluebird');
const fetch = require('node-fetch');
const EC2_METADATA_PROPERTIES = {
  INSTANCE_ID: 'instance-id'
};
const winstonLogger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({colorize: true}),
  ]
});

// Configure AWS
AWS.config.setPromisesDependency(Promise);

class Cluster {

  constructor({instanceId = null, tagName = 'Name', tagValue = 'Etcd', instance = null, autoScalingGroup = null, members = [], logger = null} = {}) {
    this.instanceId = instanceId;
    this.tagName = tagName;
    this.tagValue = tagValue;
    this.instance = instance;
    this.autoScalingGroup = autoScalingGroup;
    this.members = members;
    this.logger = logger === null ? winstonLogger : logger;

    this.getInstanceMetadata = this.getInstanceMetadata.bind(this);
    this.getInstance = this.getInstance.bind(this);
    this.getMembers = this.getMembers.bind(this);
  }

  // Get instance Metadata
  getInstanceMetadata(prop) {
    return fetch('http://169.254.169.254/latest/meta-data/' + prop)
      .then(res => {
        if (res.ok) {
          return res.text();
        }

        throw new Error(res.error);
      })
  }

  // Returns the currently running EC2 instance
  async getInstance() {

    // Did we supply a cluster object
    if (this.instance !== null) {

      // return the instance
      return this.instance;
    }

    // Does the cluster object contain an instanceid
    if (this.instanceId === null) {

      // No.
      this.logger.info('Retrieving Instance id');
      try {

        // Get the instance id from metadata
        this.instanceId = await this.getInstanceMetadata(EC2_METADATA_PROPERTIES.INSTANCE_ID);
        this.logger.info('Instance id is set to ' + this.instanceId);
      }
      catch (err) {

        throw new Error(err);
      }
    }

    try {

      // Create an ec2 service
      const ec2Service = new AWS.EC2();

      this.logger.info('Getting instance information...');

      // Get this instance information from aws
      let response = await ec2Service.describeInstances({InstanceIds: [this.instanceId]}).promise();

      // Did we receive the response we were expecting
      if (response.Reservations.length !== 1 || response.Reservations[0].Instances.length !== 1) {

        // No.  Report it
        throw new Error('Cannot find instance with id ' + this.instanceId);
      }

      // Yes.  Return the instance info
      this.logger.info('Information for instance ' + this.instanceId + ' retrieved successfully.');
      this.instance = response.Reservations[0].Instances[0];
      return this.instance;
    }
    catch (err) {

      throw new Error(err);
    }
  };

  // Returns members of the EC2 Cluster
  async getMembers() {

    // Do we have the current instance
    if (this.instance === null) {

      // No.
      try {

        // Try and get/set instance from AWS
        await this.getInstance();

        // Success?
        if (this.instance === null) throw new Error('Unable to find instance id in AWS');
      }
      catch (err) {

        throw new Error(err);
      }
    }

    const tag = this.instance.Tags.find(t => t.Key === this.tagName) || {Key: this.tagName, Value: this.tagValue};

    // @TODO: If our instance doesn't have tag value
    if (tag == null) {

      throw new Error("Current instance " + this.instanceId + ' does not have a tag ' + tag.Name);
    }

    try {
      const ec2Service = new AWS.EC2();
      const params = {
        Filters: [
          {
            Name: "tag:" + tag.Key,
            Values: [tag.Value]
          }
        ]
      };
      this.logger.info(`Retrieving Instances with tag ${JSON.stringify(params)}}`);
      let response = await ec2Service.describeInstances(params).promise();

      this.logger.info(`Cluster::getMembers response ${JSON.stringify(response)}`);
      if (response.hasOwnProperty('Reservations') && response.Reservations.length > 0) {
        response.Reservations.forEach(reservation => {
          this.members = this.members.concat(reservation.Instances)
        })
      }
      return this.members;
    }
    catch (err) {

      throw new Error(err);
    }
  }

  // Returns auto scaling group for the cluster
  async getAutoScalingGroup() {

    if (this.autoScalingGroup !== null) {
      return this.autoScalingGroup;
    }

    // Do we have the current instance
    if (this.instance === null) {

      // No.
      try {

        // Try and get/set instance from AWS
        await this.getInstance();

        // Success?
        if (this.instance === null) throw new Error('Unable to find instance id in AWS');
      }
      catch (err) {

        throw new Error(err);
      }
    }

    let autoScalingGroupName = this.instance.Tags.find(tag => tag.Key === "aws:autoscaling:groupName");
    this.logger.info(JSON.stringify(autoScalingGroupName));

    if (autoScalingGroupName === undefined) return "";

    try {
      const autoScalingService = new AWS.AutoScaling();
      const params = {
        AutoScalingGroupNames: [autoScalingGroupName.Value],
        MaxRecords: 1
      };
      let response = await autoScalingService.describeAutoScalingGroups(params).promise();
      if (response.AutoScalingGroups.length !== 1) {
        throw new Error('Cannot find autoscaling group ' + autoScalingGroupName.Value)
      }
      this.autoScalingGroup = response.AutoScalingGroups[0];
      return this.autoScalingGroup;
    }
    catch (err) {

      throw new Error(err);
    }
  }
}

module.exports = Cluster;


