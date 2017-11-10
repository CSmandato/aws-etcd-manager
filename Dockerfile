FROM node:alpine

ENV ETCDCTL_API=3
ENV AWS_DEFAULT_OUTPUT=json

RUN apk update && \
	apk add coreutils binutils python g++ make && \
	npm install aws-sdk -g

RUN mkdir /backup
ADD dist/etcd /bin/etcd
ADD dist/etcdctl /bin/etcdctl

COPY scripts/sh/entrypoint.sh /usr/bin/entrypoint.sh
RUN chmod +x /usr/bin/entrypoint.sh
COPY scripts/** /node-scripts/

WORKDIR /node-scripts
RUN npm install

ENTRYPOINT ["entrypoint.sh"]

CMD ["npm", "start"]