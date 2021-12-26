FROM python
LABEL maintainer="DevOps <devops@sevensenders.com>"

RUN curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64 && \
    chmod +x /usr/local/bin/argocd

RUN pip3 install pyyaml

COPY argocd-action.py /argocd-action.py

CMD [ "python", "argocd-action.py" ]
#CMD [ "bash" ]
