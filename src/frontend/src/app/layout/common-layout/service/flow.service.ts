import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { CollectionVersion } from '../model/piece.interface';
import { forkJoin, map, Observable, of, skipWhile, switchMap, take, tap } from 'rxjs';
import { Flow } from '../model/flow.class';
import { SeekPage } from './seek-page';
import { UUID } from 'angular2-uuid';
import { FlowVersion } from '../model/flow-version.class';
import { InstanceRun, InstanceRunState } from '../model/instance-run.interface';
import { TriggerType } from '../model/enum/trigger-type.enum';
import { FlowTemplateInterface } from '../../flow-builder/model/flow-template.interface';
import { CreateNewFlowModalComponent } from '../../flow-builder/page/flow-builder/flow-right-sidebar/create-new-flow-modal/create-new-flow-modal.component';
import { BuilderSelectors } from '../../flow-builder/store/selector/flow-builder.selector';
import { findDefaultFlowDisplayName } from '../utils';
import { Store } from '@ngrx/store';
import { BsModalRef, BsModalService } from 'ngx-bootstrap/modal';
import { FlowsActions } from '../../flow-builder/store/action/flows.action';
import { RightSideBarType } from '../model/enum/right-side-bar-type.enum';
import { VersionEditState } from '../model/enum/version-edit-state.enum';
import {
	addArtifactsToFormData,
	ArtifactAndItsNameInFormData,
	zipAllArtifacts,
} from '../model/helper/artifacts-zipping-helper';
import { CodeService } from '../../flow-builder/service/code.service';
import { CodeAction } from '../model/flow-builder/actions/code-action.interface';
import { Artifact } from '../../flow-builder/model/artifact.interface';
import { ConfigType } from '../model/enum/config-type';
import { DropdownType } from '../model/enum/config.enum';
import { DynamicDropdownSettings } from '../model/fields/variable/config-settings';

@Injectable({
	providedIn: 'root',
})
export class FlowService {
	private bsModalRef: BsModalRef;

	constructor(
		private store: Store,
		private modalService: BsModalService,
		private http: HttpClient,
		private codeService: CodeService
	) {}

	public showModalFlow() {
		this.bsModalRef = this.modalService.show(CreateNewFlowModalComponent, {
			ignoreBackdropClick: true,
		});
		this.bsModalRef.content.selectedTemplate
			.pipe(
				take(1),
				switchMap(template => {
					if (template == undefined) {
						return of(undefined);
					}
					const flowTemplate: FlowTemplateInterface = template as FlowTemplateInterface;
					return this.createFlowTemplate(flowTemplate);
				})
			)
			.subscribe();
	}

	createFlowTemplate(flowTemplate: FlowTemplateInterface) {
		return forkJoin({
			piece: this.store.select(BuilderSelectors.selectCurrentCollection).pipe(take(1)),
			flows: this.store.select(BuilderSelectors.selectFlows).pipe(take(1)),
		})
			.pipe(
				switchMap(pieceWithFlows => {
					const flowDisplayName = findDefaultFlowDisplayName(pieceWithFlows.flows);
					return this.create(pieceWithFlows.piece.id, {
						flowDisplayName: flowDisplayName,
						template: flowTemplate,
					});
				})
			)
			.pipe(
				map(response => {
					if (response != undefined) {
						this.store
							.select(BuilderSelectors.selectCurrentFlowId)
							.pipe(skipWhile(f => f != response.id))
							.pipe(take(1))
							.pipe(
								switchMap(f => {
									return this.store
										.select(BuilderSelectors.selectCurrentTabState)
										.pipe(skipWhile(f => f == undefined))
										.pipe(take(1));
								})
							)
							.subscribe(tab => {
								if (response.lastVersion.trigger?.type === TriggerType.EMPTY) {
									this.store.dispatch(
										FlowsActions.setRightSidebar({
											sidebarType: RightSideBarType.TRIGGER_TYPE,
											props: {},
										})
									);
								}
							});
						this.store.dispatch(FlowsActions.addFlow({ flow: response }));
					}
					return response;
				})
			);
	}

	create(colelctionId: UUID, request: { flowDisplayName: string; template: FlowTemplateInterface }): Observable<Flow> {
		const formData = new FormData();
		const clonedTemplate: FlowTemplateInterface = JSON.parse(JSON.stringify(request.template));
		const flowVersion: FlowVersion = new FlowVersion({
			epochCreationTime: 0,
			epochUpdateTime: 0,
			// IGNORED
			flowId: UUID.UUID(),
			// IGNORED
			id: UUID.UUID(),
			// IGNORED
			state: VersionEditState.DRAFT,
			valid: false,
			access: clonedTemplate.version.access,
			displayName: request.flowDisplayName,
			description: request.flowDisplayName + ' description',
			configs: clonedTemplate.version.configs,
			trigger: clonedTemplate.version.trigger,
		});
		const codeActions: CodeAction[] = flowVersion.codeActions();
		const codeActionsArtifacts: Artifact[] = new Array(codeActions.length);
		codeActionsArtifacts.fill(this.codeService.helloWorld());
		const artifacts$ = zipAllArtifacts(
			codeActionsArtifacts.map((art, idx) => {
				return { artifact: art, name: codeActions[idx].name };
			})
		);

		formData.append(
			'flow',
			new Blob(
				[
					JSON.stringify({
						version: flowVersion,
					}),
				],
				{ type: 'application/json' }
			)
		);

		const createFlow$ = this.http.post<Flow>(environment.apiUrl + '/collections/' + colelctionId + '/flows', formData);
		if (artifacts$.length == 0) {
			return createFlow$;
		}
		return forkJoin(artifacts$).pipe(
			tap(zippedFilesAndTheirNames => {
				addArtifactsToFormData(zippedFilesAndTheirNames, formData);
			}),
			switchMap(() => {
				return createFlow$;
			})
		);
	}

	get(flowId: UUID): Observable<Flow> {
		return this.http.get<Flow>(environment.apiUrl + '/flows/' + flowId);
	}

	getVersion(flowVersionId: UUID): Observable<FlowVersion> {
		return this.http.get<FlowVersion>(environment.apiUrl + '/flows/versions/' + flowVersionId);
	}

	listByPiece(integrationId: UUID, limit: number): Observable<SeekPage<Flow>> {
		return this.http.get<SeekPage<Flow>>(
			environment.apiUrl + '/collections/' + integrationId + '/flows?limit=' + limit
		);
	}

	listVersionsByFlowId(flowID: UUID): Observable<FlowVersion[]> {
		return this.http.get<FlowVersion[]>(environment.apiUrl + '/flows/' + flowID + '/versions');
	}

	listByPieceVersion(pieceVersion: CollectionVersion): Observable<FlowVersion[]> {
		return forkJoin(pieceVersion.flowsVersionId.map(item => this.getVersion(item)));
	}

	count(integrationId: UUID): Observable<number> {
		return this.http.get<number>(environment.apiUrl + '/collections/' + integrationId + '/flows/count');
	}

	delete(workflowId: UUID): Observable<void> {
		return this.http.delete<void>(environment.apiUrl + '/flows/' + workflowId);
	}

	update(flowId: UUID, flow: FlowVersion): Observable<Flow> {
		const formData = new FormData();
		const clonedFlowVersion: FlowVersion = FlowVersion.clone(flow);
		formData.append(
			'flow',
			new Blob([JSON.stringify(clonedFlowVersion)], {
				type: 'application/json',
			})
		);
		const dirtyStepsArtifacts = this.codeService.getDirtyArtifactsForFlowSteps(flowId);
		const artifactsAndTheirNames: ArtifactAndItsNameInFormData[] = [
			...this.getDynamicDropdownConfigsArtifacts(flow),
			...dirtyStepsArtifacts,
		];

		const updateFlow$ = this.http.put<any>(environment.apiUrl + '/flows/' + flowId + '/versions/latest', formData);
		const artifacts$ = zipAllArtifacts(artifactsAndTheirNames);
		if (artifacts$.length == 0) {
			return updateFlow$;
		}
		return forkJoin(artifacts$).pipe(
			tap(zippedFilesAndTheirNames => {
				addArtifactsToFormData(zippedFilesAndTheirNames, formData);
			}),
			switchMap(() => {
				const updateFlowWithArtifacts$ = this.http.put<any>(
					environment.apiUrl + '/flows/' + flowId + '/versions/latest',
					formData
				);
				return updateFlowWithArtifacts$;
			}),
			tap(() => {
				this.codeService.unmarkDirtyArtifactsInFlowStepsCache(flowId);
			})
		);
	}

	execute(
		collectionVersionId: UUID,
		flowVersionId,
		request: { configs: Map<String, Object>; trigger: any }
	): Observable<InstanceRun> {
		return this.http
			.post<InstanceRun>(
				environment.apiUrl +
					'/collection-versions/' +
					collectionVersionId +
					'/flow-versions/' +
					flowVersionId +
					'/runs',
				request
			)
			.pipe(
				switchMap(instanceRun => {
					if (instanceRun.state === undefined && instanceRun.stateUrl !== undefined) {
						return this.logs(instanceRun.stateUrl).pipe(
							map(st => {
								instanceRun.state = st;
								return instanceRun;
							})
						);
					}
					return of(instanceRun);
				})
			);
	}

	private logs(url: string): Observable<InstanceRunState> {
		return this.http.get<InstanceRunState>(url);
	}

	getDynamicDropdownConfigsArtifacts(flow: FlowVersion) {
		const artifacts: ArtifactAndItsNameInFormData[] = [];
		flow.configs.forEach(config => {
			const settings = config.settings as DynamicDropdownSettings;
			if (config.type === ConfigType.DROPDOWN && settings.dropdownType == DropdownType.DYNAMIC) {
				if (settings.artifactContent) artifacts.push({ artifact: settings.artifactContent, name: config.key });
			}
		});
		return artifacts;
	}
}