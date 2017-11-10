FROM node:alpine

ENV ETCDCTL_API=3

RUN apk update && \
	apk add coreutils binutils python g++ make && \
	npm install aws-sdk -g

ENV AWS_DEFAULT_OUTPUT=json

ADD dist/etcd /bin/etcd
ADD dist/etcdctl /bin/etcdctl

RUN mkdir /backup

COPY scripts/** /node-scripts/
COPY scripts/sh/entrypoint.sh /usr/bin/entrypoint.sh

RUN chmod +x /node-scripts/instance-lifecycle-termination-listener.js
RUN chmod +x /usr/bin/entrypoint.sh

WORKDIR /node-scripts
RUN npm install

ENTRYPOINT ["entrypoint.sh"]

CMD ["npm", "start"]