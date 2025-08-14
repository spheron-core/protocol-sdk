import { requestPipeline } from '@utils/index';
import { V2Manifest } from '@utils/deployment';

export class SpheronProviderModuleV2 {
  private providerHostUrl: string;
  private proxyUrl: string;

  constructor(providerHostUrl: string, proxyUrl: string) {
    this.providerHostUrl = providerHostUrl;
    this.proxyUrl = proxyUrl;
  }

  async version() {
    const url = `${this.proxyUrl}`;
    try {
      const response = await requestPipeline({
        url,
        method: 'POST',
        body: JSON.stringify({
          url: `${this.providerHostUrl}/version`,
        }),
      });
      return response;
    } catch (error) {
      throw error;
    }
  }

  async submitManfiest(
    certificate: string,
    authToken: string,
    leaseId: string,
    sdlManifest: V2Manifest
  ) {
    // if (!certificate) {
    //   console.log('Certificate not found');
    //   return;
    // }

    const url = `${this.proxyUrl}`;
    try {
      const reqBody = {
        certificate,
        authToken,
        method: 'POST',
        url: `${this.providerHostUrl}/deployment/${leaseId}/manifest`,
        body: JSON.stringify(sdlManifest),
      };
      const response = await requestPipeline({
        url,
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
      return response;
    } catch (error) {
      throw error;
    }
  }

  async updateManfiest(
    certificate: string,
    authToken: string,
    leaseId: string,
    sdlManifest: V2Manifest
  ) {
    // if (!certificate) {
    //   console.log('Certificate not found');
    //   return;
    // }

    const url = `${this.proxyUrl}`;
    try {
      const reqBody = {
        certificate,
        authToken,
        method: 'PUT',
        url: `${this.providerHostUrl}/deployment/${leaseId}/manifest`,
        body: JSON.stringify(sdlManifest),
      };
      const response = await requestPipeline({
        url,
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
      return response;
    } catch (error) {
      throw error;
    }
  }

  async getLeaseStatus(certificate: string, authToken: string, leaseId: string) {
    if (!leaseId) {
      throw new Error('Lease ID not found');
    }

    const reqBody = {
      certificate,
      authToken,
      method: 'GET',
      url: `${this.providerHostUrl}/lease/${leaseId}/status`,
    };

    const url = `${this.proxyUrl}`;
    try {
      const response = await requestPipeline({
        url,
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
      return response;
    } catch (error) {
      return { services: null, forwarded_ports: null };
    }
  }

  async getEvents(
    certificate: string,
    authToken: string,
    leaseId: string,
    service = '',
    tail = 100000
  ) {
    if (!leaseId) {
      throw new Error('Lease ID not found');
    }

    const reqBody = {
      url: `${this.providerHostUrl}/lease/${leaseId}/events?follow=false&tail=${tail}${
        service ? `&service=${service}` : ''
      }`,
      method: 'GET',
      authToken,
      certificate,
    };

    const url = `${this.proxyUrl}`;
    try {
      const response = await requestPipeline({
        method: 'POST',
        body: JSON.stringify(reqBody),
        url,
      });
      return response;
    } catch (error) {
      throw error;
    }
  }

  async getLeaseLogs(
    certificate: string,
    authToken: string,
    leaseId: string,
    service = '',
    tail = 100000,
    startup = false
  ) {
    if (!leaseId) {
      throw new Error('Lease ID not found');
    }
    const reqBody = {
      url: `${
        this.providerHostUrl
      }/lease/${leaseId}/logs?follow=false&tail=${tail}&startup=${startup}${
        service ? `&service=${service}` : ''
      }`,
      method: 'GET',
      authToken,
      certificate,
    };

    const url = `${this.proxyUrl}`;
    try {
      const response = await requestPipeline({
        url,
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
      return response;
    } catch (error) {
      return [];
    }
  }

  async getLeaseServiceStatus(
    certificate: string,
    authToken: string,
    leaseId: string,
    serviceName: string
  ) {
    if (!leaseId) {
      throw new Error('Lease ID not found');
    }

    if (!serviceName) {
      throw new Error('Service name not found');
    }

    const reqBody = {
      url: `${this.providerHostUrl}/lease/${leaseId}/service/${serviceName}/status`,
      method: 'GET',
      authToken,
      certificate,
    };

    const url = `${this.proxyUrl}`;
    try {
      const response = await requestPipeline({
        url,
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
      return response;
    } catch (error) {
      throw error;
    }
  }
}
