



const queryNodeState = instance => {
  return {
    url: `http://${instance.PrivateIpAddress}:2379/v2/stats/self`,
    options: {
      method: 'GET',
      timeout: 15000
    }
  }
};

const getClusterMembers = instance => {
  return {
    url: `http://${instance.PrivateIpAddress}:2379/v2/members`,
    options: {
      method: 'GET'
    }
  }
};

const addClusterMember = (instance, memberData) => {
  return {
    url: `http://${instance.PrivateIpAddress}:2379/v2/members`,
    options: {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(memberData)
    }
  }
};

const removeClusterMember = (instance, memberId) => {
  return {
    url: `http://${instance.PrivateIpAddress}:2379/v2/members/${memberId}`,
    options: {
      method: 'DELETE'
    }
  }
};

module.exports = {
  queryNodeState,
  getClusterMembers,
  addClusterMember,
  removeClusterMember
};