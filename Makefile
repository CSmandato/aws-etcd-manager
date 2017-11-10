.PHONY: all clean dist/etcd build


PLATFORM_BINARIES=dist/etcd-aws
IMAGE_NAME=michaelmnm/node-aws-cli
ETCD_VERSION=v3.2.9

all: $(PLATFORM_BINARIES)

clean:
	-rm $(PLATFORM_BINARIES)

dist/etcd:
	mkdir -p dist
	curl -L -s https://github.com/coreos/etcd/releases/download/${ETCD_VERSION}/etcd-${ETCD_VERSION}-linux-amd64.tar.gz |\
    		tar -C dist -xzf -
	cp dist/etcd-${ETCD_VERSION}-linux-amd64/etcd dist/etcd
	cp dist/etcd-${ETCD_VERSION}-linux-amd64/etcdctl dist/etcdctl
	rm -rf dist/etcd-${ETCD_VERSION}-linux-amd64

build: dist/etcd
	docker build -t $(IMAGE_NAME) .